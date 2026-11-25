import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { MAIL_LIMITS, MailError, type MailErrorCode } from "../src/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import { type JmapSession, UpstreamAuthError } from "../src/jmap/jmap-client";
import * as oauthOptions from "../src/oauth/options";
import { grantDirectory, oauthApi } from "../src/oauth/options";
import { STALWART } from "../src/stalwart/endpoints";
import { exchangeCode } from "../src/stalwart/oauth-client";
import { decryptSecret, type SecretBox } from "../src/vault/crypto";
import { type MailboxVault, vaultFor, WITH_ACCESS_TOKEN } from "../src/vault/mailbox-vault";
import { createFakeStalwart, type FakeStalwart, pkceChallenge } from "./fake-stalwart";

const ORIGIN = "https://mail-mcp.test.example";
const REDIRECT = "https://client.example/callback";
const A = "a@test.example";
const B = "b@test.example";
/** In the future, so alarms scheduled from it never fire on their own during the test run. */
const T0 = 1_800_000_000_000;
const SECOND = 1000;

type Stub = DurableObjectStub<MailboxVault>;

let fake: FakeStalwart;
let now = T0;
let testNo = 0;

/**
 * Storage (vault rows, KV grants, audit rows) persists across the tests of this file, while each
 * fake numbers its account ids from 1. Filler mailboxes move every test's ids into a range of
 * its own, so no two tests share a vault, a grant list or audit rows.
 */
beforeEach(() => {
  testNo++;
  fake = createFakeStalwart();
  for (let i = 0; i < testNo * 10; i++) fake.addMailbox(`filler${i}@filler.example`);
  vi.stubGlobal("fetch", fake.fetch);
  now = T0;
  vi.spyOn(clock, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mailbox = (email: string): string => fake.addMailbox(email).accountId;

const clientIds: string[] = [];

/** One Worker grant (an AI tool connection) for the mailbox `accountId`. */
async function addGrant(accountId: string): Promise<void> {
  const api = oauthApi(env, ORIGIN);
  if (clientIds.length === 0) {
    const client = await api.createClient({ redirectUris: [REDIRECT], tokenEndpointAuthMethod: "none" });
    clientIds.push(client.clientId);
  }
  const url = new URL(`${ORIGIN}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientIds[0]!,
    redirect_uri: REDIRECT,
    scope: "mail",
    state: "s",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  const request = await api.parseAuthRequest(new Request(url));
  await api.completeAuthorization({
    request,
    userId: accountId,
    metadata: {},
    scope: ["mail"],
    props: { accountId },
    revokeExistingGrants: false,
  });
}

const dir = () => grantDirectory(env, ORIGIN);

const VERIFIER = "v".repeat(50);
const RETRY = MAIL_LIMITS.grantRevokeRetrySeconds * SECOND;

/** A second sign-in of mailbox A: a new grant at the fake, tokens valid from `now`. */
async function newSignIn() {
  const code = fake.issueCode(A, { codeChallenge: await pkceChallenge(VERIFIER) });
  return exchangeCode(env, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
}

/** Signs `email` in: the vault for its account receives the fake's current tokens. */
async function signIn(email: string, accountId = mailbox(email)): Promise<{ stub: Stub; accountId: string }> {
  const stub = vaultFor(env, accountId);
  await stub.storeTokens({ accountId, email, origin: ORIGIN, ...fake.tokensFor(email) });
  return { stub, accountId };
}

function useToken(stub: Stub): Promise<{ token: string; session: JmapSession }> {
  return runInDurableObject(stub, (vault: MailboxVault) =>
    vault[WITH_ACCESS_TOKEN](async (token, session) => ({ token, session })),
  );
}

async function expectCode(p: Promise<unknown>, code: MailErrorCode): Promise<void> {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MailError);
  expect((e as MailError).code).toBe(code);
}

interface ConnectionRow {
  account_id: string;
  email: string;
  origin: string;
  access_box: string;
  refresh_box: string;
  access_expires_at: number;
  connected_at: number;
  last_used_at: number;
}

function connectionRow(stub: Stub): Promise<ConnectionRow | null> {
  return runInDurableObject(stub, (_vault: MailboxVault, state) => {
    const rows = state.storage.sql.exec("SELECT * FROM connection").toArray();
    return (rows[0] as unknown as ConnectionRow | undefined) ?? null;
  });
}

async function storedRefreshToken(stub: Stub): Promise<string> {
  const row = await connectionRow(stub);
  if (!row) throw new Error("no connection row");
  return decryptSecret(env.TOKEN_ENC_KEY, JSON.parse(row.refresh_box) as SecretBox, row.account_id);
}

const alarmAt = (stub: Stub) => runInDurableObject(stub, (_v: MailboxVault, state) => state.storage.getAlarm());

const tokenRequests = () => fake.requests.filter((r) => r.url === STALWART.token);
const revokeRequests = () => fake.requests.filter((r) => r.url === STALWART.revoke);

async function auditRows(accountId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE account_id = ? ORDER BY id")
    .bind(accountId)
    .all<Record<string, unknown>>();
  return results;
}

/** Moves the clock past the stored access token's lifetime. */
const expireAccessToken = () => {
  now += MAIL_LIMITS.accessTokenTtlSeconds * SECOND;
};

describe("MailboxVault tokens", () => {
  it("stores tokens encrypted: the SQLite row contains neither token in clear", async () => {
    const { stub, accountId } = await signIn(A);
    const tokens = fake.tokensFor(A);
    const row = await connectionRow(stub);
    expect(row).toMatchObject({
      account_id: accountId,
      email: A,
      origin: ORIGIN,
      access_expires_at: tokens.accessExpiresAt,
      connected_at: T0,
      last_used_at: T0,
    });
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(tokens.accessToken);
    expect(dump).not.toContain(tokens.refreshToken);
    expect(await storedRefreshToken(stub)).toBe(tokens.refreshToken);
    expect(await stub.status()).toEqual({ connected: true, email: A, lastUsedAt: T0 });
    expect(await alarmAt(stub)).toBe(T0 + MAIL_LIMITS.abandonedSignInSeconds * SECOND);
  });

  it("answers reconnect_required without any upstream request when nothing is stored", async () => {
    const stub = vaultFor(env, mailbox(A));
    await expectCode(useToken(stub), "reconnect_required");
    expect(fake.requests).toHaveLength(0);
    expect(await stub.status()).toEqual({ connected: false, email: null, lastUsedAt: null });
  });

  it("reuses a valid access token and refreshes an expiring one", async () => {
    const { stub, accountId } = await signIn(A);
    const first = fake.tokensFor(A);

    const used = await useToken(stub);
    expect(used.token).toBe(first.accessToken);
    expect(used.session.accountId).toBe(accountId);
    expect(tokenRequests()).toHaveLength(0);

    // 59 s before expiry the token counts as expiring.
    now = first.accessExpiresAt - 59 * SECOND;
    const refreshed = await useToken(stub);
    expect(tokenRequests()).toHaveLength(1);
    expect(refreshed.token).not.toBe(first.accessToken);
    expect(refreshed.token).toBe(fake.tokensFor(A).accessToken);
    expect(await stub.status()).toMatchObject({ connected: true, lastUsedAt: now });
  });

  it("five concurrent calls with an expired token produce exactly one refresh", async () => {
    const { stub } = await signIn(A);
    expireAccessToken();
    // All five start inside one turn of the object, so they really overlap.
    const tokens = await runInDurableObject(stub, (vault: MailboxVault) =>
      Promise.all(Array.from({ length: 5 }, () => vault[WITH_ACCESS_TOKEN](async (token) => token))),
    );
    expect(tokenRequests()).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set([fake.tokensFor(A).accessToken]));
    expect(await stub.status()).toMatchObject({ connected: true });
  });

  it("keeps the rotated refresh token, so the next refresh also works", async () => {
    const { stub } = await signIn(A);
    expireAccessToken();
    await useToken(stub);
    const rotated = fake.tokensFor(A).refreshToken;
    expect(await storedRefreshToken(stub)).toBe(rotated);

    // The vault keeps no token in memory: the next refresh presents the stored, rotated one.
    expireAccessToken();
    const again = await useToken(stub);
    expect(tokenRequests()).toHaveLength(2);
    expect(tokenRequests()[1]!.body).toMatchObject({ grant_type: "refresh_token", refresh_token: rotated });
    expect(again.token).toBe(fake.tokensFor(A).accessToken);
    expect(await storedRefreshToken(stub)).toBe(fake.tokensFor(A).refreshToken);
  });

  it("on invalid_grant wipes, revokes this mailbox's Worker grants and makes no further upstream attempt", async () => {
    const { stub, accountId: accountA } = await signIn(A);
    const accountB = mailbox(B);
    await addGrant(accountA);
    await addGrant(accountB);
    expireAccessToken();

    fake.revokeGrant(A);
    await expectCode(useToken(stub), "reconnect_required");
    const n = fake.requests.length;
    await expectCode(useToken(stub), "reconnect_required");
    expect(fake.requests).toHaveLength(n);
    expect(await dir().hasGrants(accountA)).toBe(false);
    expect(await dir().hasGrants(accountB)).toBe(true);
    expect(await connectionRow(stub)).toBeNull();
    // The follow-up revocation of the Worker grants (KV listing lag) is the only alarm left.
    expect(await alarmAt(stub)).toBe(now + RETRY);
    expect(await auditRows(accountA)).toMatchObject([{ event: "upstream_revoked", outcome: "ok", email: A }]);
  });

  it("one 401 on a cached token refreshes once and retries", async () => {
    const { stub } = await signIn(A);
    fake.expireAccessToken(A); // Stalwart dropped the token early; the vault still thinks it is valid
    const used = await useToken(stub);
    expect(tokenRequests()).toHaveLength(1);
    expect(used.token).toBe(fake.tokensFor(A).accessToken);
    expect(await stub.status()).toMatchObject({ connected: true });
  });

  it("a 401 again right after a successful refresh wipes and answers reconnect_required", async () => {
    const { stub, accountId } = await signIn(A);
    let calls = 0;
    const attempt = runInDurableObject(stub, (vault: MailboxVault) =>
      vault[WITH_ACCESS_TOKEN](async () => {
        calls++;
        // Any 401 from Stalwart inside `fn` surfaces as UpstreamAuthError.
        throw new UpstreamAuthError();
      }),
    );
    await expectCode(attempt, "reconnect_required");
    expect(calls).toBe(2);
    expect(tokenRequests()).toHaveLength(1);
    expect(await connectionRow(stub)).toBeNull();
    expect(await auditRows(accountId)).toMatchObject([{ event: "upstream_revoked", outcome: "ok" }]);
  });

  it("after an upstream_rejected refresh makes no refresh attempt for 300 s and wipes nothing", async () => {
    const { stub } = await signIn(A);
    expireAccessToken();
    fake.failNext("http-401"); // a bare 401: e.g. the Worker's client credentials are wrong
    await expectCode(useToken(stub), "upstream_rejected");
    expect(tokenRequests()).toHaveLength(1);

    const n = fake.requests.length;
    now += 299 * SECOND;
    await expectCode(useToken(stub), "upstream_unavailable");
    expect(fake.requests).toHaveLength(n);
    expect(await stub.status()).toMatchObject({ connected: true });

    now += 2 * SECOND;
    const used = await useToken(stub);
    expect(tokenRequests()).toHaveLength(2);
    expect(used.token).toBe(fake.tokensFor(A).accessToken);
    expect(revokeRequests()).toHaveLength(0);
  });

  it("a wipe during a refresh is not undone by the refresh, which revokes its new token", async () => {
    const { stub } = await signIn(A);
    expireAccessToken();
    const [used] = await runInDurableObject(stub, (vault: MailboxVault) =>
      Promise.allSettled([vault[WITH_ACCESS_TOKEN](async (token) => token), vault.wipe("blocked")]),
    );
    expect(used.status).toBe("rejected");
    expect(((used as PromiseRejectedResult).reason as MailError).code).toBe("reconnect_required");
    expect(tokenRequests()).toHaveLength(1);
    expect(await connectionRow(stub)).toBeNull();
    // The wipe revokes the stored token, the refresh the rotated one it got back.
    const presented = (tokenRequests()[0]!.body as { refresh_token: string }).refresh_token;
    const revoked = revokeRequests().map((r) => (r.body as { token: string }).token);
    expect(revoked).toHaveLength(2);
    expect(revoked).toContain(presented);
    const rotated = revoked.find((t) => t !== presented)!;
    expect(fake.knowsToken(rotated)).toBe(true);
    expect(fake.revoked(A)).toBe(true);
  });

  it("a 503 on refresh wipes nothing and the next call tries again", async () => {
    const { stub } = await signIn(A);
    expireAccessToken();
    fake.failNext("http-503");
    await expectCode(useToken(stub), "upstream_unavailable");
    expect(await stub.status()).toMatchObject({ connected: true });
    const used = await useToken(stub);
    expect(tokenRequests()).toHaveLength(2);
    expect(used.token).toBe(fake.tokensFor(A).accessToken);
    expect(revokeRequests()).toHaveLength(0);
  });

  it("refuses when the session belongs to another account, without calling fn", async () => {
    mailbox(A);
    // Tokens of mailbox A stored in the vault of another account id.
    const { stub } = await signIn(A, `other-account-${testNo}`);
    let called = false;
    const attempt = runInDurableObject(stub, (vault: MailboxVault) =>
      vault[WITH_ACCESS_TOKEN](async () => {
        called = true;
      }),
    );
    await expectCode(attempt, "account_mismatch");
    expect(called).toBe(false);
  });

  it("a bad TOKEN_ENC_KEY is internal", async () => {
    const { stub } = await signIn(A);
    const attempt = runInDurableObject(stub, (vault: MailboxVault) => {
      (vault as unknown as { env: typeof env }).env = { ...env, TOKEN_ENC_KEY: "short" };
      return vault[WITH_ACCESS_TOKEN](async (t) => t);
    });
    await expectCode(attempt, "internal");
  });

  it("a second sign-in replaces the tokens and the first tool's calls keep working", async () => {
    const { stub, accountId } = await signIn(A);
    await useToken(stub);
    now += 5 * SECOND;
    const second = await newSignIn();
    await stub.storeTokens({ accountId, email: A, origin: ORIGIN, ...second });
    const row = await connectionRow(stub);
    expect(row).toMatchObject({ connected_at: T0, last_used_at: now, access_expires_at: second.accessExpiresAt });
    expect(await storedRefreshToken(stub)).toBe(second.refreshToken);

    const used = await useToken(stub);
    expect(used.token).toBe(second.accessToken);
    expireAccessToken();
    const refreshed = await useToken(stub);
    expect(fake.knowsToken(refreshed.token)).toBe(true);
    expect(tokenRequests().at(-1)!.body).toMatchObject({ refresh_token: second.refreshToken });
  });
});

describe("MailboxVault lifetimes", () => {
  it("wipes and revokes at Stalwart 10 minutes after a sign-in that never got a grant", async () => {
    const { stub, accountId } = await signIn(A);
    const refreshToken = fake.tokensFor(A).refreshToken;
    expect(await alarmAt(stub)).toBe(T0 + MAIL_LIMITS.abandonedSignInSeconds * SECOND);

    now += MAIL_LIMITS.abandonedSignInSeconds * SECOND;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.status()).toEqual({ connected: false, email: null, lastUsedAt: null });
    expect(fake.revoked(A)).toBe(true);
    expect(revokeRequests()[0]!.body).toMatchObject({ token: refreshToken });
    expect(await alarmAt(stub)).toBeNull();
    expect(await auditRows(accountId)).toMatchObject([
      { event: "connection_wiped", outcome: "ok", error_code: "grants_gone", email: A },
    ]);
  });

  it("keeps the connection and re-arms the alarm for 24 h while a grant exists", async () => {
    const { stub, accountId } = await signIn(A);
    await addGrant(accountId);
    now += MAIL_LIMITS.abandonedSignInSeconds * SECOND;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.status()).toMatchObject({ connected: true });
    expect(await alarmAt(stub)).toBe(now + MAIL_LIMITS.grantCheckSeconds * SECOND);
    expect(fake.revoked(A)).toBe(false);
    expect(await auditRows(accountId)).toEqual([]);
  });

  it("wipes, revokes at Stalwart and revokes the Worker grants after 30 idle days", async () => {
    const { stub, accountId } = await signIn(A);
    await addGrant(accountId);
    await useToken(stub);
    const lastUsed = now;

    now = lastUsed + MAIL_LIMITS.idleWipeSeconds * SECOND;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.status()).toMatchObject({ connected: true }); // exactly 30 days is not yet idle

    now = lastUsed + MAIL_LIMITS.idleWipeSeconds * SECOND + SECOND;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.status()).toMatchObject({ connected: false });
    expect(fake.revoked(A)).toBe(true);
    expect(await dir().hasGrants(accountId)).toBe(false);
    expect(await alarmAt(stub)).toBe(now + RETRY); // the follow-up revocation only
    expect(await auditRows(accountId)).toMatchObject([
      { event: "connection_wiped", outcome: "ok", error_code: "idle", email: A },
    ]);
  });

  it("blocked revokes at Stalwart and the Worker grants; wipe without a connection does nothing", async () => {
    const { stub, accountId } = await signIn(A);
    await addGrant(accountId);
    await stub.wipe("blocked");
    expect(fake.revoked(A)).toBe(true);
    expect(await dir().hasGrants(accountId)).toBe(false);
    expect(await alarmAt(stub)).toBe(now + RETRY); // the follow-up revocation only

    const n = fake.requests.length;
    await stub.wipe("blocked");
    expect(fake.requests).toHaveLength(n);
    expect(await auditRows(accountId)).toHaveLength(1);
    // The follow-up runs once and leaves no alarm and no upstream request behind.
    now += RETRY;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fake.requests).toHaveLength(n);
    expect(await alarmAt(stub)).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("audits wipes without any token", async () => {
    const { stub, accountId } = await signIn(A);
    expireAccessToken();
    await useToken(stub);
    const seen = [fake.tokensFor(A).accessToken, fake.tokensFor(A).refreshToken];
    await stub.wipe("blocked");
    const rows = await auditRows(accountId);
    expect(rows).toMatchObject([
      { event: "connection_wiped", outcome: "ok", error_code: "blocked", account_id: accountId, email: A },
    ]);
    const dump = JSON.stringify(rows);
    for (const t of seen) expect(dump).not.toContain(t);
    expect(dump).not.toContain("fake-at-");
    expect(dump).not.toContain("fake-rt-");
  });
});


/**
 * Holds every answer of the token endpoint until `release()`. `requested` resolves once a token
 * request reached the fake (so the fake has already rotated); `issued` collects the refresh
 * tokens of successful answers. With `answer`, the endpoint answers that instead of the fake.
 */
function holdTokenAnswers(answer?: () => Response) {
  let release!: () => void;
  let markRequested!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const requested = new Promise<void>((r) => (markRequested = r));
  const issued: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== STALWART.token) return fake.fetch(input, init);
    const res = answer ? answer() : await fake.fetch(input, init);
    markRequested();
    await gate;
    if (res.status === 200) issued.push(((await res.clone().json()) as { refresh_token: string }).refresh_token);
    return res;
  });
  return { release, requested, issued };
}

const invalidGrant = () =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });

const fulfilled = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};

describe("MailboxVault decisions are bound to one connection", () => {
  it("a refresh that settles after a wipe and a new sign-in keeps the new sign-in's tokens", async () => {
    const { stub, accountId } = await signIn(A);
    expireAccessToken();
    const second = await newSignIn();
    const held = holdTokenAnswers();
    const [used] = await runInDurableObject(stub, (vault: MailboxVault) =>
      Promise.allSettled([
        vault[WITH_ACCESS_TOKEN](async (token) => token),
        (async () => {
          await held.requested;
          await vault.wipe("blocked");
          await vault.storeTokens({ accountId, email: A, origin: ORIGIN, ...second });
          held.release();
        })(),
      ]),
    );
    expect(fulfilled(used!)).toBe(second.accessToken);
    expect(await storedRefreshToken(stub)).toBe(second.refreshToken);
    expect(held.issued).toHaveLength(1);
    expect(revokeRequests().map((r) => (r.body as { token: string }).token)).toContain(held.issued[0]);
  });

  it("a storeTokens replacement during a refresh keeps the replacement's tokens", async () => {
    const { stub, accountId } = await signIn(A);
    expireAccessToken();
    const second = await newSignIn();
    const held = holdTokenAnswers();
    const [used] = await runInDurableObject(stub, (vault: MailboxVault) =>
      Promise.allSettled([
        vault[WITH_ACCESS_TOKEN](async (token) => token),
        (async () => {
          await held.requested;
          await vault.storeTokens({ accountId, email: A, origin: ORIGIN, ...second });
          held.release();
        })(),
      ]),
    );
    expect(fulfilled(used!)).toBe(second.accessToken);
    expect(await storedRefreshToken(stub)).toBe(second.refreshToken);
    expect(revokeRequests().map((r) => (r.body as { token: string }).token)).toEqual(held.issued);
  });

  it("invalid_grant for a connection that was wiped and signed in again leaves the new one and its grants", async () => {
    const { stub, accountId } = await signIn(A);
    expireAccessToken();
    const second = await newSignIn();
    const held = holdTokenAnswers(invalidGrant);
    const [used] = await runInDurableObject(stub, (vault: MailboxVault) =>
      Promise.allSettled([
        vault[WITH_ACCESS_TOKEN](async (token) => token),
        (async () => {
          await held.requested;
          await vault.wipe("blocked");
          await vault.storeTokens({ accountId, email: A, origin: ORIGIN, ...second });
          await addGrant(accountId);
          held.release();
        })(),
      ]),
    );
    expect(fulfilled(used!)).toBe(second.accessToken);
    expect(await storedRefreshToken(stub)).toBe(second.refreshToken);
    expect(await dir().hasGrants(accountId)).toBe(true);
    expect((await auditRows(accountId)).map((r) => r.event)).toEqual(["connection_wiped"]); // the blocked wipe only
  });

  it("a second 401 for the token of a replaced connection does not wipe the new connection", async () => {
    const { stub, accountId } = await signIn(A);
    expireAccessToken();
    const second = await newSignIn();
    const tokens: string[] = [];
    const result = await runInDurableObject(stub, (vault: MailboxVault) =>
      vault[WITH_ACCESS_TOKEN](async (token) => {
        tokens.push(token);
        if (tokens.length === 1) {
          // Right after this call's refresh: a new sign-in lands, then the old token is refused.
          await vault.storeTokens({ accountId, email: A, origin: ORIGIN, ...second });
          throw new UpstreamAuthError();
        }
        return token;
      }),
    );
    expect(result).toBe(second.accessToken);
    expect(tokens).toHaveLength(2);
    expect(await storedRefreshToken(stub)).toBe(second.refreshToken);
    expect(await auditRows(accountId)).toEqual([]);
  });

  it("a 401 right after the refresh this call triggered wipes as upstream_revoked", async () => {
    const { stub, accountId } = await signIn(A);
    expireAccessToken();
    let calls = 0;
    const attempt = runInDurableObject(stub, (vault: MailboxVault) =>
      vault[WITH_ACCESS_TOKEN](async () => {
        calls++;
        throw new UpstreamAuthError();
      }),
    );
    await expectCode(attempt, "reconnect_required");
    expect(calls).toBe(1);
    expect(tokenRequests()).toHaveLength(1);
    expect(await connectionRow(stub)).toBeNull();
    expect(await auditRows(accountId)).toMatchObject([{ event: "upstream_revoked", outcome: "ok", email: A }]);
  });

  it("fn never runs with the token of a connection replaced during the session fetch", async () => {
    const { stub, accountId } = await signIn(A);
    const second = await newSignIn();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markRequested!: () => void;
    const requested = new Promise<void>((r) => (markRequested = r));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      if ((input instanceof Request ? input.url : String(input)) === STALWART.session) {
        markRequested();
        await gate;
      }
      return res;
    });
    const tokens: string[] = [];
    await runInDurableObject(stub, (vault: MailboxVault) =>
      Promise.all([
        vault[WITH_ACCESS_TOKEN](async (token) => {
          tokens.push(token);
        }),
        (async () => {
          await requested;
          await vault.storeTokens({ accountId, email: A, origin: ORIGIN, ...second });
          release();
        })(),
      ]),
    );
    expect(tokens).toEqual([second.accessToken]);
  });

  it("an alarm whose lookup found no grants does not wipe a connection replaced during the lookup", async () => {
    const { stub, accountId } = await signIn(A);
    const second = await newSignIn();
    await runInDurableObject(stub, async (vault: MailboxVault) => {
      vi.spyOn(oauthOptions, "grantDirectory").mockReturnValue({
        hasGrants: async () => {
          await vault.storeTokens({ accountId, email: A, origin: ORIGIN, ...second });
          return false;
        },
        revokeAll: async () => 0,
      });
      await vault.alarm();
    });
    expect(await storedRefreshToken(stub)).toBe(second.refreshToken);
    expect(await alarmAt(stub)).toBe(now + MAIL_LIMITS.abandonedSignInSeconds * SECOND);
    expect(revokeRequests()).toHaveLength(0);
    expect(await auditRows(accountId)).toEqual([]);
  });
});

describe("MailboxVault alarm resilience", () => {
  it("a failing grant lookup keeps the connection and the re-armed alarm; a later alarm still wipes", async () => {
    const { stub, accountId } = await signIn(A);
    now += MAIL_LIMITS.abandonedSignInSeconds * SECOND;
    const spy = vi.spyOn(oauthOptions, "grantDirectory").mockReturnValue({
      hasGrants: async () => {
        throw new Error("kv down");
      },
      revokeAll: async () => 0,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.status()).toMatchObject({ connected: true });
    expect(await alarmAt(stub)).toBe(now + MAIL_LIMITS.grantCheckSeconds * SECOND);

    spy.mockRestore();
    now += MAIL_LIMITS.grantCheckSeconds * SECOND;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.status()).toMatchObject({ connected: false });
    expect(await alarmAt(stub)).toBeNull();
    expect(await auditRows(accountId)).toMatchObject([{ event: "connection_wiped", error_code: "grants_gone" }]);
  });
});

/** Replaces the grant directory everywhere in this isolate (the vault included). */
function spyDirectory(revokeAll: (accountId: string) => Promise<number>) {
  const real = oauthOptions.grantDirectory;
  return vi.spyOn(oauthOptions, "grantDirectory").mockImplementation((e, origin, options) => ({
    hasGrants: (id) => real(e, origin, options).hasGrants(id),
    revokeAll,
  }));
}

describe("MailboxVault keeps Worker grants in step with its connection", () => {
  it("a first sign-in revokes grants left over from an earlier connection", async () => {
    const accountId = mailbox(A);
    await addGrant(accountId); // an orphan: no connection holds it
    await signIn(A, accountId);
    expect(await dir().hasGrants(accountId)).toBe(false);
  });

  it("a sign-in for the stored address keeps the grants; another address does not inherit them", async () => {
    const { stub, accountId } = await signIn(A);
    await addGrant(accountId);
    await stub.storeTokens({ accountId, email: A.toUpperCase(), origin: ORIGIN, ...(await newSignIn()) });
    expect(await dir().hasGrants(accountId)).toBe(true);

    await stub.storeTokens({ accountId, email: "renamed@test.example", origin: ORIGIN, ...(await newSignIn()) });
    expect(await dir().hasGrants(accountId)).toBe(false);
    expect(await stub.status()).toMatchObject({ connected: true, email: "renamed@test.example" });
  });

  it("stores nothing when the grants of a new connection cannot be revoked", async () => {
    const accountId = mailbox(A);
    spyDirectory(async () => {
      throw new Error("kv down");
    });
    const tokens = fake.tokensFor(A);
    const store = runInDurableObject(vaultFor(env, accountId), (vault: MailboxVault) =>
      vault.storeTokens({ accountId, email: A, origin: ORIGIN, ...tokens }),
    );
    await expectCode(store, "internal");
    expect(await connectionRow(vaultFor(env, accountId))).toBeNull();
    expect(await alarmAt(vaultFor(env, accountId))).toBeNull();
  });

  it("a wipe whose grant revocation fails is audited as an error and retried by the alarm", async () => {
    const { stub, accountId } = await signIn(A);
    await addGrant(accountId);
    const spy = spyDirectory(async () => {
      throw new Error("kv down");
    });
    await stub.wipe("blocked");
    expect(await connectionRow(stub)).toBeNull();
    expect(await alarmAt(stub)).toBe(now + RETRY);
    expect(await auditRows(accountId)).toMatchObject([{ event: "connection_wiped", outcome: "error", error_code: "blocked" }]);
    expect(await dir().hasGrants(accountId)).toBe(true);

    // Still failing: re-armed in 5 minutes.
    now += RETRY;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmAt(stub)).toBe(now + RETRY);

    spy.mockRestore();
    now += RETRY;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await dir().hasGrants(accountId)).toBe(false);
    expect(await alarmAt(stub)).toBeNull();
  });

  it("gives the retries up 24 hours after the wipe", async () => {
    const { stub } = await signIn(A);
    const revokeAll = vi.fn(async (): Promise<number> => {
      throw new Error("kv down");
    });
    spyDirectory(revokeAll);
    await stub.wipe("idle");
    const wiped = now;
    let runs = 0;
    while ((await alarmAt(stub)) !== null) {
      now = (await alarmAt(stub))!;
      await runDurableObjectAlarm(stub);
      runs++;
    }
    expect(now - wiped).toBeLessThanOrEqual(MAIL_LIMITS.grantRevokeRetryWindowSeconds * SECOND);
    expect(runs).toBe(MAIL_LIMITS.grantRevokeRetryWindowSeconds / MAIL_LIMITS.grantRevokeRetrySeconds);
    expect(revokeAll).toHaveBeenCalledTimes(runs + 1);
  });

  it("after a wipe that revoked the grants, the alarm revokes once more 5 minutes later", async () => {
    const { stub, accountId } = await signIn(A);
    const revokeAll = vi.fn(async () => 0);
    spyDirectory(revokeAll);
    await stub.wipe("blocked");
    expect(revokeAll).toHaveBeenCalledTimes(1);
    now += RETRY;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(revokeAll).toHaveBeenCalledTimes(2);
    expect(revokeAll).toHaveBeenLastCalledWith(accountId);
    expect(await alarmAt(stub)).toBeNull();
  });

  it("a wipe for missing grants schedules no revocation", async () => {
    const { stub } = await signIn(A);
    const revokeAll = vi.fn(async () => 0);
    spyDirectory(revokeAll);
    now += MAIL_LIMITS.abandonedSignInSeconds * SECOND;
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ connected: false });
    expect(revokeAll).not.toHaveBeenCalled();
    expect(await alarmAt(stub)).toBeNull();
  });

  it("a sign-in after the wipe takes over: the pending follow-up never revokes the new grants", async () => {
    const { stub, accountId } = await signIn(A);
    await stub.wipe("blocked");
    const pending = () =>
      runInDurableObject(stub, (_v: MailboxVault, state) =>
        state.storage.sql.exec("SELECT kind FROM pending_grant_revocation").toArray(),
      );
    expect(await pending()).toEqual([{ kind: "follow_up" }]);
    await stub.storeTokens({ accountId, email: A, origin: ORIGIN, ...(await newSignIn()) });
    expect(await pending()).toEqual([]);
    await addGrant(accountId);
    expect(await alarmAt(stub)).toBe(now + MAIL_LIMITS.abandonedSignInSeconds * SECOND);
    now += MAIL_LIMITS.abandonedSignInSeconds * SECOND;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await dir().hasGrants(accountId)).toBe(true);
    expect(await stub.status()).toMatchObject({ connected: true });
  });

  it("confirmGrant moves the next grant check a day ahead; without a connection it does nothing", async () => {
    const { stub } = await signIn(A);
    now += 9 * 60 * SECOND;
    await stub.confirmGrant();
    expect(await alarmAt(stub)).toBe(now + MAIL_LIMITS.grantCheckSeconds * SECOND);

    const empty = vaultFor(env, mailbox(B));
    await empty.confirmGrant();
    expect(await alarmAt(empty)).toBeNull();
  });
});
