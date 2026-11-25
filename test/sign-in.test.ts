import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { MAIL_LIMITS } from "../src/mail";
import { env } from "cloudflare:workers";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as audit from "../src/audit";
import { clock } from "../src/clock";
import worker from "../src/index";
import { grantDirectory, oauthApi } from "../src/oauth/options";
import { takePending } from "../src/oauth/pending";
import { STALWART } from "../src/stalwart/endpoints";
import { type MailboxVault, vaultFor } from "../src/vault/mailbox-vault";
import { createFakeStalwart, type FakeStalwart } from "./fake-stalwart";
import {
  authorizeUrl,
  beginFlow,
  callTool,
  connect,
  CookieJar,
  type Flow,
  ORIGIN,
  pkce,
  postForm,
  registerClient,
  send,
  TOOL_REDIRECT,
} from "./oauth-flow";

const A = "a@test.example";
const C = "c@test.example";

let fake: FakeStalwart;
let testNo = 0;

/**
 * Storage (vaults, KV grants, D1 rows) persists across the tests of this file, while each fake
 * numbers its account ids from 1. Filler mailboxes give every test an id range of its own.
 */
beforeEach(() => {
  testNo++;
  fake = createFakeStalwart();
  for (let i = 0; i < testNo * 10; i++) fake.addMailbox(`filler${i}@filler.example`);
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const dir = () => grantDirectory(env, ORIGIN);
const connected = async (accountId: string) => (await vaultFor(env, accountId).status()).connected;

interface AuditRow {
  event: string;
  outcome: string;
  account_id: string | null;
  email: string | null;
  client_id: string | null;
  client_name: string | null;
  error_code: string | null;
}
async function auditRows(accountId: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE account_id = ? ORDER BY id")
    .bind(accountId)
    .all<AuditRow>();
  return results;
}

async function grantCount(accountId: string): Promise<number> {
  return (await oauthApi(env, ORIGIN).listUserGrants(accountId)).items.length;
}

/** Runs the flow up to Stalwart's answer; returns the flow and the callback URL. */
async function atCallback(email: string, opts: { clientName?: string } = {}): Promise<{ flow: Flow; callback: string }> {
  const flow = await beginFlow(opts);
  return { flow, callback: fake.authorize(flow.stalwartUrl, email) };
}

/** Runs the flow up to our approval page; returns the flow and the handle. */
async function atApproval(email: string, opts: { clientName?: string } = {}): Promise<{ flow: Flow; handle: string }> {
  const { flow, callback } = await atCallback(email, opts);
  const res = await send(callback, { jar: flow.jar, ip: flow.ip });
  expect(res.status).toBe(302);
  return { flow, handle: new URL(res.headers.get("location")!).searchParams.get("h")! };
}

const HTML_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};
function expectHtmlHeaders(res: Response): void {
  for (const [name, value] of Object.entries(HTML_HEADERS)) expect(res.headers.get(name)).toBe(value);
}

describe("sign-in through Stalwart", () => {
  it("redirects to Stalwart with PKCE S256, the mail scope and our callback", async () => {
    const flow = await beginFlow();
    const res = flow.responses[0]!;
    expect(res.status).toBe(302);
    const to = new URL(flow.stalwartUrl);
    expect(`${to.origin}${to.pathname}`).toBe(STALWART.authorize);
    const p = to.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("test-client");
    expect(p.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(p.get("scope")).toBe(STALWART.scope);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toBeTruthy();
    expect(flow.jar.names().some((n) => n.startsWith("__Host-oauth-upstream"))).toBe(true);
    // The fake binds the code to that challenge, so a full sign-in proves the verifier matches it.
    const c = await connect(fake, A);
    expect(c.accessToken).toBeTruthy();
  });

  it("issues a Worker token after Allow, and that token is not a Stalwart token", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const c = await connect(fake, A);
    expect(c.accessToken).toBeTruthy();
    expect(fake.knowsToken(c.accessToken!)).toBe(false);
    expect(fake.knowsToken(c.refreshToken!)).toBe(false);
    expect(await connected(accountA)).toBe(true);
    expect((await callTool(c.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
  });

  it("refuses a callback with a missing, wrong or replayed state", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { flow, callback } = await atCallback(A);
    const opts = { jar: flow.jar, ip: flow.ip };

    const missing = new URL(callback);
    missing.searchParams.delete("state");
    const r1 = await send(missing.toString(), opts);
    expect(r1.status).toBe(400);
    expectHtmlHeaders(r1);

    const wrong = new URL(callback);
    wrong.searchParams.set("state", "not-a-state");
    expect((await send(wrong.toString(), opts)).status).toBe(400);

    expect(await connected(accountA)).toBe(false);
    expect(fake.requests.filter((r) => r.url === STALWART.token)).toHaveLength(0);

    expect((await send(callback, opts)).status).toBe(302);
    // The state was consumed: a replay is refused and creates nothing new.
    const replay = await send(callback, opts);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
    expect(fake.requests.filter((r) => r.url === STALWART.token)).toHaveLength(1);
    expect(await dir().hasGrants(accountA)).toBe(false);
  });

  it("refuses a callback whose state belongs to another browser (no cookie)", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { callback } = await atCallback(A);
    const res = await send(callback, { jar: new CookieJar() });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(fake.requests.filter((r) => r.url === STALWART.token)).toHaveLength(0);
    expect(await connected(accountA)).toBe(false);
  });

  it("refuses an iss parameter that is not the mail server", async () => {
    const accountA = fake.addMailbox(A).accountId;
    for (const iss of ["https://evil.example", null]) {
      const { flow, callback } = await atCallback(A);
      const url = new URL(callback);
      if (iss === null) url.searchParams.delete("iss");
      else url.searchParams.set("iss", iss);
      const res = await send(url.toString(), { jar: flow.jar, ip: flow.ip });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(fake.requests.filter((r) => r.url === STALWART.token)).toHaveLength(0);
    expect(await connected(accountA)).toBe(false);
  });

  it("refuses a callback without a code", async () => {
    const { flow, callback } = await atCallback(A);
    const url = new URL(callback);
    url.searchParams.delete("code");
    expect((await send(url.toString(), { jar: flow.jar, ip: flow.ip })).status).toBe(400);
    expect(fake.requests.filter((r) => r.url === STALWART.token)).toHaveLength(0);
  });

  it("sends the AI tool back with access_denied when the user declines at Stalwart, and stores nothing", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const flow = await beginFlow();
    const res = await send(fake.authorize(flow.stalwartUrl, A, { deny: true }), { jar: flow.jar, ip: flow.ip });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(TOOL_REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("tool-state");
    expect(fake.requests.filter((r) => r.url === STALWART.token)).toHaveLength(0);
    expect(await connected(accountA)).toBe(false);
    expect(await auditRows(accountA)).toEqual([]);
  });

  it("issues no Worker token without Allow", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const c = await connect(fake, A, { decision: "deny" });
    expect(c.accessToken).toBeUndefined();
    expect(await dir().hasGrants(accountA)).toBe(false);
    const back = new URL(c.responses.at(-1)!.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(TOOL_REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("Deny still stores the fresh Stalwart tokens, so an already connected tool keeps working", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const first = await connect(fake, A);
    await connect(fake, A, { decision: "deny", clientName: "Other" });
    expect(await connected(accountA)).toBe(true);
    expect((await callTool(first.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
    // The vault uses the newest Stalwart grant: the last JMAP call carried its access token.
    const latest = fake.tokensFor(A).accessToken;
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${latest}`);
  });

  it("a POST to /approve without the consent cookie creates no grant", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { flow, handle } = await atApproval(A);
    const res = await postForm("/approve", { h: handle, decision: "allow" }, { ip: flow.ip });
    expect(res.status).toBe(400);
    expectHtmlHeaders(res);
    expect(await dir().hasGrants(accountA)).toBe(false);
    expect((await auditRows(accountA)).map((r) => r.event)).toEqual(["sign_in"]);
  });

  it("an approval handle works once", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { flow, handle } = await atApproval(A);
    // The jar loses the consent cookie on the first POST; a copy taken before replays the exact form.
    const replayJar = flow.jar.copy();
    const first = await postForm("/approve", { h: handle, decision: "allow" }, { jar: flow.jar, ip: flow.ip });
    expect(first.status).toBe(302);
    expect(new URL(first.headers.get("location")!).searchParams.get("code")).toBeTruthy();

    for (const jar of [flow.jar, replayJar]) {
      const again = await postForm("/approve", { h: handle, decision: "allow" }, { jar, ip: flow.ip });
      expect(again.status).toBe(400);
      expect(again.headers.get("location")).toBeNull();
    }
    expect(await grantCount(accountA)).toBe(1);
    expect((await auditRows(accountA)).filter((r) => r.event === "approval_allowed")).toHaveLength(1);
  });

  it("GET /approve shows the page and changes nothing, even with decision=allow", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { flow, handle } = await atApproval(A, { clientName: "Viewer" });
    const res = await send(`/approve?h=${encodeURIComponent(handle)}&decision=allow`, { jar: flow.jar, ip: flow.ip });
    expect(res.status).toBe(200);
    expectHtmlHeaders(res);
    const html = await res.text();
    expect(html).toContain("Viewer");
    expect(html).toContain(A);
    expect(html).toContain("tool.example");
    expect(await dir().hasGrants(accountA)).toBe(false);
    expect((await auditRows(accountA)).map((r) => r.event)).toEqual(["sign_in"]);
    // The handle is still usable after the GET.
    const post = await postForm("/approve", { h: handle, decision: "allow" }, { jar: flow.jar, ip: flow.ip });
    expect(post.status).toBe(302);
  });

  it("GET /approve with an unknown or old handle answers the expired page", async () => {
    expect((await send("/approve?h=nope")).status).toBe(410);
    const { flow, handle } = await atApproval(A);
    const later = Date.now() + 601_000;
    vi.spyOn(clock, "now").mockImplementation(() => later);
    const res = await send(`/approve?h=${handle}`, { jar: flow.jar, ip: flow.ip });
    expect(res.status).toBe(410);
    expectHtmlHeaders(res);
  });

  it("stores only the SHA-256 of the handle in the pending table", async () => {
    const { handle } = await atApproval(A);
    const { results } = await env.DB.prepare("SELECT * FROM pending_approvals").all<Record<string, unknown>>();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(handle));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(results.some((r) => r.handle_hash === hex)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(handle);
  });

  it("staging refuses a mailbox that is not on SIGNIN_ALLOWLIST and stores nothing", async () => {
    const accountC = fake.addMailbox(C).accountId;
    const c = await connect(fake, C);
    expect(c.responses.at(-1)!.status).toBe(403);
    expectHtmlHeaders(c.responses.at(-1)!);
    expect((await vaultFor(env, accountC).status()).connected).toBe(false);
    expect(fake.revoked(C)).toBe(true);
    const rows = await auditRows(accountC);
    expect(rows).toMatchObject([{ event: "sign_in_refused", outcome: "refused", error_code: "not_allowed", client_id: c.clientId }]);
    const { results } = await env.DB.prepare("SELECT * FROM pending_approvals WHERE account_id = ?").bind(accountC).all();
    expect(results).toEqual([]);
  });

  it("refuses a blocked mailbox, wipes its vault and audits it", async () => {
    const accountA = fake.addMailbox(A).accountId;
    expect((await connect(fake, A)).accessToken).toBeTruthy();
    expect(await connected(accountA)).toBe(true);
    await env.DB.prepare("INSERT INTO blocked_accounts (key, reason, created_at) VALUES (?, 'test', 0)").bind(accountA).run();
    try {
      const c = await connect(fake, A, { clientName: "Blocked Tool" });
      expect(c.accessToken).toBeUndefined();
      expect(c.responses.at(-1)!.status).toBe(403);
      expect(await connected(accountA)).toBe(false);
      // Both Stalwart grants are dead: the stored one (wiped) and the one this sign-in just got.
      const [stored, fresh] = fake.issuedByCode(A);
      expect(fresh).toBeDefined();
      for (const t of [stored!, fresh!]) {
        expect(fake.isLive(t.accessToken)).toBe(false);
        expect(fake.isLive(t.refreshToken)).toBe(false);
      }
      expect(await dir().hasGrants(accountA)).toBe(false);
      const refused = (await auditRows(accountA)).filter((r) => r.event === "sign_in_refused");
      expect(refused).toMatchObject([{ outcome: "refused", error_code: "blocked", client_name: "Blocked Tool" }]);
    } finally {
      await env.DB.prepare("DELETE FROM blocked_accounts WHERE key = ?").bind(accountA).run();
    }
  });

  it("refuses a sign-in whose address the MCP endpoint would not accept", async () => {
    const odd = "plainuser"; // a Stalwart login name that is not an address
    const accountOdd = fake.addMailbox(odd).accountId;
    const { flow, callback } = await atCallback(odd);
    const ctx = createExecutionContext();
    // On the sign-in allow-list, so only the address check can refuse it.
    const res = await worker.fetch!(
      new Request(callback, { headers: { cookie: flow.jar.header(), "cf-connecting-ip": flow.ip }, redirect: "manual" }),
      { ...env, SIGNIN_ALLOWLIST: `${env.SIGNIN_ALLOWLIST},${odd}` },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    expectHtmlHeaders(res);
    expect(res.headers.get("location")).toBeNull();
    expect(await connected(accountOdd)).toBe(false);
    expect(fake.isLive(fake.issuedByCode(odd)[0]!.refreshToken)).toBe(false);
    expect(await auditRows(accountOdd)).toMatchObject([
      { event: "sign_in_refused", outcome: "refused", error_code: "not_allowed", client_id: flow.clientId },
    ]);
    const { results } = await env.DB.prepare("SELECT * FROM pending_approvals WHERE account_id = ?").bind(accountOdd).all();
    expect(results).toEqual([]);
  });

  it("fails closed when the block list cannot be read at the callback", async () => {
    const accountA = fake.addMailbox(A).accountId;
    vi.spyOn(audit, "isBlocked").mockRejectedValue(new Error("D1 down"));
    const c = await connect(fake, A);
    expect(c.responses.at(-1)!.status).toBe(500);
    expect(c.accessToken).toBeUndefined();
    expect(await connected(accountA)).toBe(false);
    expect(fake.revoked(A)).toBe(true);
  });

  it("refuses Allow when the mailbox was blocked after the callback", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { flow, handle } = await atApproval(A);
    await env.DB.prepare("INSERT INTO blocked_accounts (key, reason, created_at) VALUES (?, 'test', 0)").bind(accountA).run();
    try {
      const res = await postForm("/approve", { h: handle, decision: "allow" }, { jar: flow.jar, ip: flow.ip });
      expect(res.status).toBe(403);
      expect(await dir().hasGrants(accountA)).toBe(false);
      // Refused at Allow: audited, and the connection stored at the callback is wiped.
      expect(await connected(accountA)).toBe(false);
      expect(fake.isLive(fake.issuedByCode(A)[0]!.refreshToken)).toBe(false);
      const refused = (await auditRows(accountA)).filter((r) => r.event === "sign_in_refused");
      expect(refused).toMatchObject([{ outcome: "refused", error_code: "blocked", client_id: flow.clientId }]);
    } finally {
      await env.DB.prepare("DELETE FROM blocked_accounts WHERE key = ?").bind(accountA).run();
    }
  });

  it("Allow confirms the grant: the abandoned-sign-in check cannot wipe a connection KV does not list yet", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const base = Date.now();
    let now = base;
    vi.spyOn(clock, "now").mockImplementation(() => now);
    const { flow, handle } = await atApproval(A);
    const alarm = () => runInDurableObject(vaultFor(env, accountA), (_v: MailboxVault, state) => state.storage.getAlarm());
    expect(await alarm()).toBe(base + MAIL_LIMITS.abandonedSignInSeconds * 1000);

    now = base + 9 * 60_000;
    const res = await postForm("/approve", { h: handle, decision: "allow" }, { jar: flow.jar, ip: flow.ip });
    expect(res.status).toBe(302);
    expect(await alarm()).toBe(now + MAIL_LIMITS.grantCheckSeconds * 1000);
    expect(await connected(accountA)).toBe(true);
  });

  it("refuses Allow when the pending row belongs to another client", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { flow, handle } = await atApproval(A);
    await env.DB.prepare("UPDATE pending_approvals SET client_id = 'someone-else' WHERE account_id = ?").bind(accountA).run();
    const res = await postForm("/approve", { h: handle, decision: "allow" }, { jar: flow.jar, ip: flow.ip });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await dir().hasGrants(accountA)).toBe(false);
  });

  it("creates no grant on Allow when the vault lost its tokens in the meantime", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { flow, handle } = await atApproval(A);
    await vaultFor(env, accountA).wipe("idle");
    const res = await postForm("/approve", { h: handle, decision: "allow" }, { jar: flow.jar, ip: flow.ip });
    expect(res.status).toBe(410);
    expect(await dir().hasGrants(accountA)).toBe(false);
  });

  it("ends on an error page and stores nothing when Stalwart returns no refresh token", async () => {
    const accountA = fake.addMailbox(A).accountId;
    fake.omitRefreshTokenOnce();
    const c = await connect(fake, A);
    const last = c.responses.at(-1)!;
    expect(last.status).toBe(502);
    expectHtmlHeaders(last);
    expect(await last.text()).not.toMatch(/fake-|refresh/i);
    expect(await connected(accountA)).toBe(false);
    expect(await auditRows(accountA)).toEqual([]);
  });

  it("revokes the new Stalwart token when the JMAP session cannot be read", async () => {
    fake.addMailbox(A);
    const { flow, callback } = await atCallback(A);
    // The token request succeeds, the session request after it fails.
    const realFetch = fake.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url === STALWART.session) return new Response("down", { status: 503 });
      return realFetch(input, init);
    });
    const res = await send(callback, { jar: flow.jar, ip: flow.ip });
    expect(res.status).toBe(502);
    expect(fake.revoked(A)).toBe(true);
  });

  it("ends an /authorize with an unknown client or a foreign redirect URI on a page, never a redirect", async () => {
    const ip = "198.51.100.7";
    const { challenge } = await pkce();
    const unknown = await send(authorizeUrl("no-such-client", challenge, "https://attacker.example/cb"), { ip });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();
    expectHtmlHeaders(unknown);

    const clientId = await registerClient("Tool", ip);
    const foreign = await send(authorizeUrl(clientId, challenge, "https://attacker.example/cb"), { ip });
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("location")).toBeNull();
    expect(await foreign.text()).not.toContain("attacker.example");
  });

  it("answers the failed page without redirecting when the Stalwart client id is not configured", async () => {
    const ip = "198.51.100.8";
    const clientId = await registerClient("Tool", ip);
    const { challenge } = await pkce();
    const ctx = createExecutionContext();
    const res = await worker.fetch!(
      new Request(authorizeUrl(clientId, challenge), { headers: { "cf-connecting-ip": ip } }),
      { ...env, STALWART_OAUTH_CLIENT_ID: "" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expectHtmlHeaders(res);
  });

  it("answers 429 on /authorize beyond 30 requests per minute from one address", async () => {
    const ip = "203.0.113.30";
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await send("/authorize", { ip })).status);
    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Another address is not affected.
    expect((await send("/authorize", { ip: "203.0.113.31" })).status).not.toBe(429);
  });

  it("audits sign_in, approval_allowed and approval_denied with client id and name", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const allowed = await connect(fake, A, { clientName: "Tool One" });
    const denied = await connect(fake, A, { decision: "deny", clientName: "Tool Two" });
    const rows = await auditRows(accountA);
    const pick = ({ event, outcome, email, client_id, client_name }: AuditRow) => ({ event, outcome, email, client_id, client_name });
    expect(rows.map(pick)).toEqual([
      { event: "sign_in", outcome: "ok", email: A, client_id: allowed.clientId, client_name: "Tool One" },
      { event: "approval_allowed", outcome: "ok", email: A, client_id: allowed.clientId, client_name: "Tool One" },
      { event: "sign_in", outcome: "ok", email: A, client_id: denied.clientId, client_name: "Tool Two" },
      { event: "approval_denied", outcome: "ok", email: A, client_id: denied.clientId, client_name: "Tool Two" },
    ]);
  });

  it("the grant's props are exactly { accountId, email }", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const c = await connect(fake, A, { clientName: "Props Tool" });
    const token = await oauthApi(env, ORIGIN).unwrapToken(c.accessToken!);
    expect(token!.grant.props).toEqual({ accountId: accountA, email: A });
    expect(token!.userId).toBe(accountA);
    const grants = await oauthApi(env, ORIGIN).listUserGrants(accountA);
    expect(grants.items[0]!.metadata).toEqual({ email: A, clientName: "Props Tool" });
  });

  it("a Worker refresh token yields a new access token; a revoked grant does not", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const c = await connect(fake, A);
    const refresh = (token: string) =>
      postForm("/token", { grant_type: "refresh_token", refresh_token: token, client_id: c.clientId });
    const res = await refresh(c.refreshToken!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token).toBeTruthy();
    expect(body.access_token).not.toBe(c.accessToken);
    expect((await callTool(body.access_token, "list_mailboxes", {})).isError).toBeFalsy();

    await dir().revokeAll(accountA);
    expect((await refresh(body.refresh_token)).status).toBe(400);
  });

  it("the scheduled handler deletes audit rows older than 90 days", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO audit_log (at, event, account_id, outcome) VALUES (?, 'sign_in', 'old-row', 'ok'), (?, 'sign_in', 'new-row', 'ok')")
      .bind(now - 91 * 86400, now - 89 * 86400)
      .run();
    await worker.scheduled(createScheduledController(), env);
    expect(await auditRows("old-row")).toEqual([]);
    expect(await auditRows("new-row")).toHaveLength(1);
  });

  it("the scheduled handler still purges OAuth data when the audit purge fails, and logs only a marker", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(audit, "purgeAudit").mockRejectedValue(new Error("secret detail"));
    const purge = vi.spyOn(OAuthProvider.prototype, "purgeExpiredData");
    await worker.scheduled(createScheduledController(), env);
    expect(log).toHaveBeenCalledExactlyOnceWith("scheduled_purge_failed", "audit");
    expect(purge).toHaveBeenCalled();
    expect(purge.mock.calls[0]![0]).toBe(env);
  });

  it("the scheduled handler continues the OAuth purge with its cursor until done", async () => {
    const page = (done: boolean, cursor?: string) => ({ grantsChecked: 0, grantsPurged: 0, tokensChecked: 0, tokensPurged: 0, done, cursor });
    const purge = vi
      .spyOn(OAuthProvider.prototype, "purgeExpiredData")
      .mockResolvedValueOnce(page(false, "c1"))
      .mockResolvedValueOnce(page(false, "c2"))
      .mockResolvedValueOnce(page(true));
    await worker.scheduled(createScheduledController(), env);
    expect(purge.mock.calls.map((c) => c[1]?.cursor)).toEqual([undefined, "c1", "c2"]);
  });

  it("the scheduled handler stops the OAuth purge after 10 rounds", async () => {
    let n = 0;
    const purge = vi.spyOn(OAuthProvider.prototype, "purgeExpiredData").mockImplementation(async () => ({
      grantsChecked: 0,
      grantsPurged: 0,
      tokensChecked: 0,
      tokensPurged: 0,
      done: false,
      cursor: `c${++n}`,
    }));
    await worker.scheduled(createScheduledController(), env);
    expect(purge).toHaveBeenCalledTimes(10);
  });
});

describe("takePending", () => {
  it("returns a row once and refuses one older than 600 s", async () => {
    const { putPending } = await import("../src/oauth/pending");
    const row = { accountId: "p1", email: A, clientId: "c", clientName: "n", redirectHost: "h.example" };
    await putPending(env.DB, "handle-1", row);
    expect(await takePending(env.DB, "handle-1")).toMatchObject(row);
    expect(await takePending(env.DB, "handle-1")).toBeNull();

    await putPending(env.DB, "handle-2", row);
    const later = Date.now() + 601_000;
    vi.spyOn(clock, "now").mockImplementation(() => later);
    expect(await takePending(env.DB, "handle-2")).toBeNull();
  });
});
