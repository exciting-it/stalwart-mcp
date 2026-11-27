/**
 * The approval page names the tools that already have access to the mailbox, and Allow
 * disconnects the ones the user unticked. Driven through `worker.fetch` against the stand-in.
 */
import { env } from "cloudflare:workers";
import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauthOptions from "../src/oauth/options";
import { APPROVAL_SCRIPT } from "../src/oauth/approval-script";
import { toolKey } from "../src/oauth/connected-tools";
import { createFakeStalwart, type FakeStalwart } from "./fake-stalwart";
import {
  approvalFields,
  beginFlow,
  callTool,
  connect,
  type FormFields,
  ORIGIN,
  postForm,
  registerClient,
  send,
  nextIp,
  TOOL_REDIRECT,
} from "./oauth-flow";

const A = "a@test.example";
const B = "b@test.example";
const MARCH_3 = Date.UTC(2026, 2, 3, 12);
const JUNE_1 = Date.UTC(2026, 5, 1, 12);
const JUNE_20 = Date.UTC(2026, 5, 20, 12);
const JUNE_21 = Date.UTC(2026, 5, 21, 12);

let fake: FakeStalwart;
let testNo = 0;

// Storage persists across the tests of this file; filler mailboxes give each test its own account ids.
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

const api = () => oauthOptions.oauthApi(env, ORIGIN);
const grantsOf = async (accountId: string): Promise<GrantSummary[]> => oauthOptions.listGrants(api(), accountId);
const clientsOf = async (accountId: string) => (await grantsOf(accountId)).map((g) => g.clientId).sort();

/** One more Worker grant of `clientId` for the account, created at `at` (ms), as Allow would write it. */
async function addGrant(accountId: string, email: string, clientId: string, clientName: string, at?: number): Promise<void> {
  const url = new URL("/authorize", ORIGIN);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: TOOL_REDIRECT,
    scope: "mail",
    state: "s",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  const helpers = api();
  const request = await helpers.parseAuthRequest(new Request(url));
  const now = at === undefined ? null : vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    await helpers.completeAuthorization({
      request,
      userId: accountId,
      metadata: { email, clientName },
      scope: ["mail"],
      props: { accountId, email },
      revokeExistingGrants: false,
    });
  } finally {
    now?.mockRestore();
  }
}

/** A registered tool with one grant for the account. */
async function addTool(accountId: string, email: string, clientName: string, at?: number): Promise<string> {
  const clientId = await registerClient(clientName === "" ? "unnamed" : clientName.slice(0, 200), nextIp());
  await addGrant(accountId, email, clientId, clientName, at);
  return clientId;
}

/** Runs a sign-in of `email` up to our approval page. */
async function atApproval(email: string, opts: { clientName?: string; clientId?: string } = {}) {
  const flow = await beginFlow(opts);
  const res = await send(fake.authorize(flow.stalwartUrl, email), { jar: flow.jar, ip: flow.ip });
  expect(res.status).toBe(302);
  const approveAt = res.headers.get("location")!;
  const handle = new URL(approveAt).searchParams.get("h")!;
  const page = async (lang = "en") => {
    const r = await send(approveAt, { jar: flow.jar, ip: flow.ip, headers: { "accept-language": lang } });
    expect(r.status).toBe(200);
    return r.text();
  };
  const post = (fields: FormFields) => postForm("/approve", fields, { jar: flow.jar, ip: flow.ip });
  return { flow, handle, page, post };
}

interface AuditRow {
  event: string;
  outcome: string;
  email: string | null;
  client_id: string | null;
  client_name: string | null;
  result_count: number | null;
}
async function auditRows(accountId: string, event: string): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE account_id = ? AND event = ? ORDER BY id")
    .bind(accountId, event)
    .all<AuditRow>();
  return results;
}

/** `/mcp` with a token, raw: a revoked grant answers 401. */
async function mcpStatus(accessToken: string): Promise<number> {
  const res = await send("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return res.status;
}

describe("the approval page lists the tools already connected", () => {
  it("shows nothing extra for the first tool of a mailbox", async () => {
    fake.addMailbox(A);
    const c = await connect(fake, A);
    const page = await c.responses[2]!.text();
    expect(page).not.toContain("<fieldset");
    expect(page).not.toContain('name="shown"');
  });

  it("groups the grants by tool, escapes and caps the names, and puts no id into the page", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const script = await connect(fake, A, { clientName: "<script>alert(1)</script>" });
    await addGrant(accountA, A, script.clientId, "<script>alert(1)</script>", MARCH_3);
    const long = await addTool(accountA, A, "x".repeat(500), JUNE_20);
    const empty = await addTool(accountA, A, "", JUNE_21);
    const claude = await registerClient("Claude", nextIp());
    await addGrant(accountA, A, claude, "Claude", JUNE_1);

    const { page } = await atApproval(A, { clientId: claude });
    const en = await page("en");
    const form = /<fieldset class="tools">[\s\S]*<\/fieldset>/.exec(en)![0];
    // Three other tools (one of them with two grants), newest first, and the connecting tool's own.
    const names = [...form.matchAll(/<span class="name">([^<]*)<\/span> stays connected/g)].map((m) => m[1]);
    expect(names).toEqual(["Unnamed tool", "x".repeat(100), "&lt;script&gt;alert(1)&lt;/script&gt;"]);
    // The page's own script aside, there is none: the tool's name stayed text.
    expect(en.replace(`<script>${APPROVAL_SCRIPT}</script>`, "")).not.toContain("<script>");
    expect(en).not.toContain("x".repeat(101));
    expect(form).toContain("Connected since 3 March 2026");
    expect(form).toContain("Connected since 20 June 2026");
    expect(form).toContain('<span class="name">Claude</span><span class="when">This tool&#39;s earlier connection, since 1 June 2026.');
    const boxes = [...form.matchAll(/<input type="checkbox" id="([^"]+)" name="keep" value="[0-9a-f]{32}" checked>/g)];
    expect(boxes).toHaveLength(3);
    for (const [, id] of boxes) expect(form).toContain(`<label for="${id}">`);

    const de = await page("de");
    expect(de).toContain("Verbunden seit 3. März 2026");
    expect(de).toContain("Verbunden seit 20. Juni 2026");
    expect(de).toContain('<span class="name">Unbenanntes Werkzeug</span> bleibt verbunden');

    // Neither grant ids nor client ids reach the browser.
    for (const g of await grantsOf(accountA)) {
      for (const html of [en, de]) {
        expect(html).not.toContain(g.id);
        expect(html).not.toContain(g.clientId);
      }
    }
    expect([script.clientId, long, empty, claude].every((id) => !en.includes(id))).toBe(true);
  });
});

describe("Allow disconnects the tools the user unticked", () => {
  it("with everything left ticked, nothing is revoked and the new grant is created", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const one = await connect(fake, A, { clientName: "One" });
    const two = await connect(fake, A, { clientName: "Two" });
    const three = await connect(fake, A, { clientName: "Three" });
    expect(three.accessToken).toBeTruthy();
    expect(await clientsOf(accountA)).toEqual([one.clientId, two.clientId, three.clientId].sort());
    expect(await auditRows(accountA, "connection_removed")).toEqual([]);
    for (const c of [one, two, three]) expect((await callTool(c.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
  });

  it("revokes every grant of exactly the unticked tool, audits it once, and its token is refused", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const n8n = await connect(fake, A, { clientName: "n8n" });
    await addGrant(accountA, A, n8n.clientId, "n8n");
    const other = await connect(fake, A, { clientName: "Other" });
    expect((await grantsOf(accountA)).filter((g) => g.clientId === n8n.clientId)).toHaveLength(2);

    const claude = await connect(fake, A, { clientName: "Claude", untick: ["n8n"] });
    expect(claude.accessToken).toBeTruthy();
    expect(await clientsOf(accountA)).toEqual([other.clientId, claude.clientId].sort());
    expect(await auditRows(accountA, "connection_removed")).toMatchObject([
      { outcome: "ok", email: A, client_id: n8n.clientId, client_name: "n8n", result_count: 2 },
    ]);
    expect(await auditRows(accountA, "approval_allowed")).toHaveLength(3);
    expect(await mcpStatus(n8n.accessToken!)).toBe(401);
    expect((await callTool(other.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
    expect((await callTool(claude.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
  });

  it("decides the tools beyond the first 20 as one entry", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const first = await connect(fake, A, { clientName: "First" });
    const tools: string[] = [];
    for (let i = 1; i <= 22; i++) tools.push(await addTool(accountA, A, `Tool ${i}`, JUNE_1 + i * 60_000));
    const { page, post } = await atApproval(A, { clientName: "Claude" });
    const html = await page();
    expect(html.match(/name="keep" value="[0-9a-f]{32}" checked>/g)).toHaveLength(20);
    // `First` (connected today) and Tool 22 … Tool 4 are shown; Tool 3, 2 and 1 are the rest.
    expect(html).toContain('<span class="name">3 more tools</span> stay connected');
    expect(html).not.toContain(">Tool 3<");

    const res = await post([...approvalFields(html, ["3 more tools"]), ["decision", "allow"]]);
    expect(res.status).toBe(302);
    const left = await clientsOf(accountA);
    for (const id of tools.slice(0, 3)) expect(left).not.toContain(id);
    for (const id of [first.clientId, ...tools.slice(3)]) expect(left).toContain(id);
    expect(await auditRows(accountA, "connection_removed")).toHaveLength(3);
  });

  it("the connecting tool's own earlier connection is replaced; the other tools are the user's choice", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const claude = await connect(fake, A, { clientName: "Claude" });
    const n8n = await connect(fake, A, { clientName: "n8n" });
    const again = await connect(fake, A, { clientId: claude.clientId });
    expect(again.accessToken).toBeTruthy();
    expect(await clientsOf(accountA)).toEqual([claude.clientId, n8n.clientId].sort());
    expect(await mcpStatus(claude.accessToken!)).toBe(401);
    expect((await callTool(again.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
    expect((await callTool(n8n.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
  });

  it("a grant created between the page and Allow is left alone", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const old = await connect(fake, A, { clientName: "Old" });
    const { page, post } = await atApproval(A, { clientName: "Claude" });
    const html = await page();
    const late = await addTool(accountA, A, "Late");
    const res = await post([...approvalFields(html, ["Old"]), ["decision", "allow"]]);
    expect(res.status).toBe(302);
    const left = await clientsOf(accountA);
    expect(left).toContain(late);
    expect(left).not.toContain(old.clientId);
  });

  it("Deny revokes nothing, whatever was unticked", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const old = await connect(fake, A, { clientName: "Old" });
    const denied = await connect(fake, A, { clientName: "Claude", decision: "deny", untick: ["Old"] });
    expect(denied.accessToken).toBeUndefined();
    expect(await clientsOf(accountA)).toEqual([old.clientId]);
    expect(await auditRows(accountA, "connection_removed")).toEqual([]);
  });

  it("a failing revocation grants nothing and answers with the failed page", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const old = await connect(fake, A, { clientName: "Old" });
    const { page, post, flow } = await atApproval(A, { clientName: "Claude" });
    const html = await page();
    const real = oauthOptions.oauthApi;
    vi.spyOn(oauthOptions, "oauthApi").mockImplementation((e, origin) => {
      const helpers = real(e, origin);
      vi.spyOn(helpers, "revokeGrant").mockRejectedValue(new Error("kv down"));
      return helpers;
    });
    const res = await post([...approvalFields(html, ["Old"]), ["decision", "allow"]]);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("The connection could not be completed.");
    vi.restoreAllMocks();
    expect(await clientsOf(accountA)).toEqual([old.clientId]);
    expect((await grantsOf(accountA)).some((g) => g.clientId === flow.clientId)).toBe(false);
    expect(await auditRows(accountA, "approval_allowed")).toHaveLength(1);
    expect(await auditRows(accountA, "connection_removed")).toEqual([]);
  });
});

describe("the form cannot reach other grants (security invariant)", () => {
  it("keys of another account, another handle or no entry revoke nothing, here or there", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const accountB = fake.addMailbox(B).accountId;
    const toolA = await connect(fake, A, { clientName: "Tool A" });
    const toolB = await connect(fake, B, { clientName: "Tool B" });
    const { handle, page, post, flow } = await atApproval(A, { clientName: "Claude" });
    await page();
    const forged = [
      "0".repeat(32),
      await toolKey(accountB, handle, toolB.clientId),
      await toolKey(accountA, "another-handle", toolA.clientId),
      await toolKey(accountA, handle, toolB.clientId),
      toolA.clientId,
      toolB.clientId,
      ...(await grantsOf(accountA)).map((g) => g.id),
      ...(await grantsOf(accountB)).map((g) => g.id),
    ];
    const fields: [string, string][] = [["h", handle], ["decision", "allow"]];
    for (const key of forged) fields.push(["shown", key], ["rest", key]);
    const res = await post(fields);
    expect(res.status).toBe(302);
    expect(await clientsOf(accountA)).toEqual([toolA.clientId, flow.clientId].sort());
    expect(await clientsOf(accountB)).toEqual([toolB.clientId]);
    expect(await auditRows(accountA, "connection_removed")).toEqual([]);
    expect(await auditRows(accountB, "connection_removed")).toEqual([]);
    expect((await callTool(toolB.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
  });
});

describe("the gap this closes", () => {
  it("after the application is removed at the mail server, reconnecting one tool does not silently revive the other", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const toolA = await connect(fake, A, { clientName: "Tool A" });
    const toolB = await connect(fake, A, { clientName: "Tool B" });
    fake.revokeGrant(A); // the user removes the application at the mail server

    const again = await connect(fake, A, { clientId: toolA.clientId, untick: ["Tool B"] });
    expect(again.accessToken).toBeTruthy();
    expect(await mcpStatus(toolB.accessToken!)).toBe(401);
    expect((await callTool(again.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
    expect(await clientsOf(accountA)).toEqual([toolA.clientId]);
    // Both were connected within the same second, so their order is not fixed.
    const removed = (await auditRows(accountA, "connection_removed")).sort((x, y) => x.client_name!.localeCompare(y.client_name!));
    expect(removed).toMatchObject([
      // Tool A's own earlier connection, which the page said Allow replaces.
      { client_id: toolA.clientId, client_name: "Tool A", result_count: 1 },
      { client_id: toolB.clientId, client_name: "Tool B", result_count: 1 },
    ]);
  });
});
