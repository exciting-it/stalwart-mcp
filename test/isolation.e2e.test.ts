/**
 * The central promise, end to end: through `worker.fetch`, with real KV, D1 and Durable Objects
 * of the test runtime and the fake Stalwart. No mock of anything inside the Worker.
 */
import { MAIL_ERROR_MESSAGES } from "../src/mail";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import * as oauthOptions from "../src/oauth/options";
import { grantDirectory } from "../src/oauth/options";
import { STALWART } from "../src/stalwart/endpoints";
import { type MailboxVault, vaultFor } from "../src/vault/mailbox-vault";
import { createFakeStalwart, type FakeStalwart } from "./fake-stalwart";
import { callTool, connect, ORIGIN, send } from "./oauth-flow";

const A = "a@test.example";
const B = "b@test.example";

let fake: FakeStalwart;
let testNo = 0;

/** Storage persists across the tests of a file; filler mailboxes give each test account ids of its own. */
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

/** Deletes the vault's connection row directly, leaving the Worker grants in place. */
const dropConnection = (accountId: string) =>
  runInDurableObject(vaultFor(env, accountId), (_v: MailboxVault, state) => {
    state.storage.sql.exec("DELETE FROM connection");
  });

const structured = (r: Awaited<ReturnType<typeof callTool>>) =>
  r.structuredContent as { messages: { subject: string }[]; message_id?: string };

const rawMcp = (accessToken: string | null) =>
  send("/mcp", {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_mailboxes", arguments: {} } }),
  });

describe("mail connector isolation, end to end", () => {
  it("user A cannot read user B's mail", async () => {
    const accountIdA = fake.addMailbox(A).accountId;
    const accountIdB = fake.addMailbox(B).accountId;
    const a = await connect(fake, A);
    const b = await connect(fake, B);
    expect(a.accessToken).toBeTruthy();
    expect(b.accessToken).toBeTruthy();
    const secret = fake.addMessage(B, { subject: "B only", body: "B only body" });

    const before = fake.requests.length;
    const search = await callTool(a.accessToken!, "search_mail", { text: "B only" });
    expect(structured(search).messages).toEqual([]);
    const foreign = await callTool(a.accessToken!, "read_thread", { thread_id: secret.threadId });
    expect(foreign.isError).toBe(true);
    expect(JSON.stringify(foreign)).not.toContain("B only");
    expect(JSON.stringify(search)).not.toContain("B only");
    const aRequests = fake.requests.slice(before);

    // Every upstream request of A's calls carries A's token and A's account id, and none carries B's.
    expect(aRequests.length).toBeGreaterThan(0);
    const tokensA = fake.tokensFor(A);
    const tokensB = fake.tokensFor(B);
    for (const r of aRequests) {
      expect(r.authorization).toBe(`Bearer ${tokensA.accessToken}`);
      expect(r.authorization).not.toContain(tokensB.accessToken);
      expect(JSON.stringify(r.body ?? "")).not.toContain(tokensB.refreshToken);
      const calls = (r.body as { methodCalls?: [string, { accountId?: string }, string][] } | null)?.methodCalls;
      for (const [, args] of calls ?? []) {
        expect(args.accountId).toBe(accountIdA);
        expect(args.accountId).not.toBe(accountIdB);
      }
    }
    expect(aRequests.some((r) => (r.body as { methodCalls?: unknown[] } | null)?.methodCalls)).toBe(true);

    const own = await callTool(b.accessToken!, "read_thread", { thread_id: secret.threadId });
    expect(structured(own).messages[0]!.subject).toBe("B only");
  });

  it("user A cannot read user B's contacts or address books", async () => {
    const accountIdA = fake.addMailbox(A).accountId;
    const accountIdB = fake.addMailbox(B).accountId;
    const a = await connect(fake, A);
    const b = await connect(fake, B);
    const mine = fake.addContact(A, { name: { full: "A's friend" } });
    const secret = fake.addContact(B, { name: { full: "B's secret" }, emails: { e: { address: "secret@b.example" } } });

    const before = fake.requests.length;
    const own = await callTool(a.accessToken!, "search_contacts", {});
    expect((own.structuredContent as { contacts: { id: string }[] }).contacts.map((c) => c.id)).toEqual([mine.id]);
    const byText = await callTool(a.accessToken!, "search_contacts", { text: "secret" });
    const byBook = await callTool(a.accessToken!, "search_contacts", { address_book_id: secret.addressBookId });
    for (const r of [byText, byBook]) expect((r.structuredContent as { contacts: unknown[] }).contacts).toEqual([]);
    const foreign = await callTool(a.accessToken!, "read_contact", { contact_id: secret.id });
    expect(foreign).toEqual({ isError: true, content: [{ type: "text", text: MAIL_ERROR_MESSAGES.not_found }] });
    expect(JSON.stringify([own, byText, byBook, foreign])).not.toContain("B's secret");

    const aRequests = fake.requests.slice(before);
    const tokensA = fake.tokensFor(A);
    expect(aRequests.length).toBeGreaterThan(0);
    for (const r of aRequests) {
      expect(r.authorization).toBe(`Bearer ${tokensA.accessToken}`);
      const calls = (r.body as { methodCalls?: [string, { accountId?: string }, string][] } | null)?.methodCalls;
      for (const [name, args] of calls ?? []) {
        expect(args.accountId).toBe(accountIdA);
        expect(args.accountId).not.toBe(accountIdB);
        expect(name).toMatch(/\/(get|query)$/);
      }
    }
    const theirs = await callTool(b.accessToken!, "read_contact", { contact_id: secret.id });
    expect((theirs.structuredContent as { contact: { name: string } }).contact.name).toBe("B's secret");
  });

  it("user A cannot read user B's calendars or events", async () => {
    const accountIdA = fake.addMailbox(A).accountId;
    const accountIdB = fake.addMailbox(B).accountId;
    const a = await connect(fake, A);
    const b = await connect(fake, B);
    const day = { after: "2026-11-27T00:00:00Z", before: "2026-11-28T00:00:00Z" };
    const mine = fake.addEvent(A, { title: "A's lunch", start: "2026-11-27T12:00:00" });
    const privateCalendar = fake.addCalendar(B, "B's private");
    const secret = fake.addEvent(B, { title: "B's secret", start: "2026-11-27T12:00:00", calendarIds: { [privateCalendar.id]: true } });

    const before = fake.requests.length;
    const calendars = await callTool(a.accessToken!, "list_calendars", {});
    expect((calendars.structuredContent as { calendars: { id: string }[] }).calendars.map((c) => c.id)).toEqual([fake.defaultCalendarId(A)]);
    const own = await callTool(a.accessToken!, "search_events", day);
    expect((own.structuredContent as { events: { id: string }[] }).events.map((e) => e.id)).toEqual([mine.id]);
    const byText = await callTool(a.accessToken!, "search_events", { ...day, text: "secret" });
    const byCalendar = await callTool(a.accessToken!, "search_events", { ...day, calendar_id: privateCalendar.id });
    for (const r of [byText, byCalendar]) expect((r.structuredContent as { events: unknown[] }).events).toEqual([]);
    const foreign = await callTool(a.accessToken!, "read_event", { event_id: secret.id });
    expect(foreign).toEqual({ isError: true, content: [{ type: "text", text: MAIL_ERROR_MESSAGES.not_found }] });
    expect(JSON.stringify([calendars, own, byText, byCalendar, foreign])).not.toContain("B's");

    const aRequests = fake.requests.slice(before);
    const tokensA = fake.tokensFor(A);
    expect(aRequests.length).toBeGreaterThan(0);
    for (const r of aRequests) {
      expect(r.authorization).toBe(`Bearer ${tokensA.accessToken}`);
      const calls = (r.body as { methodCalls?: [string, { accountId?: string }, string][] } | null)?.methodCalls;
      for (const [name, args] of calls ?? []) {
        expect(args.accountId).toBe(accountIdA);
        expect(args.accountId).not.toBe(accountIdB);
        expect(name).toMatch(/\/(get|query)$/);
      }
    }
    const theirs = await callTool(b.accessToken!, "read_event", { event_id: secret.id });
    expect((theirs.structuredContent as { event: { title: string } }).event.title).toBe("B's secret");
  });

  it("a mailbox connected with the mail scope only gets not_granted for contacts and calendars, audited as refused", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const a = await connect(fake, A);
    // As if the mailbox had connected before the areas were switched on.
    fake.restrictToMail(A);
    fake.addContact(A, { name: { full: "Hidden" } });

    const before = fake.requests.filter((r) => r.url === `${STALWART.origin}/jmap/`).length;
    const calls: [string, Record<string, unknown>][] = [
      ["search_contacts", {}],
      ["read_contact", { contact_id: "ct1" }],
      ["list_calendars", {}],
      ["search_events", { after: "2026-11-27T00:00:00Z", before: "2026-11-28T00:00:00Z" }],
      ["read_event", { event_id: "ev1" }],
    ];
    for (const [name, args] of calls) {
      const r = await callTool(a.accessToken!, name, args);
      expect(r).toEqual({ isError: true, content: [{ type: "text", text: MAIL_ERROR_MESSAGES.not_granted }] });
    }
    // Only the session was read: no JMAP method call went out for any of these tools.
    expect(fake.requests.filter((r) => r.url === `${STALWART.origin}/jmap/`).length).toBe(before);
    const { results } = await env.DB.prepare(
      "SELECT tool, outcome, error_code FROM audit_log WHERE account_id = ? AND event = 'tool_call' ORDER BY id",
    )
      .bind(accountA)
      .all();
    expect(results).toEqual([
      { tool: "search_contacts", outcome: "refused", error_code: "not_granted" },
      { tool: "read_contact", outcome: "refused", error_code: "not_granted" },
      { tool: "list_calendars", outcome: "refused", error_code: "not_granted" },
      { tool: "search_events", outcome: "refused", error_code: "not_granted" },
      { tool: "read_event", outcome: "refused", error_code: "not_granted" },
    ]);
    // Mail is unaffected.
    expect((await callTool(a.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
  });

  it("a token for A is refused on /mcp after A's grant is revoked", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const a = await connect(fake, A);
    expect((await callTool(a.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
    expect(await grantDirectory(env, ORIGIN).revokeAll(accountA)).toBe(1);
    const res = await rawMcp(a.accessToken!);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("without a bearer token /mcp answers 401 with a resource_metadata pointer", async () => {
    const res = await rawMcp(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer .*resource_metadata="https:\/\/[^"]+\/\.well-known\/oauth-protected-resource[^"]*"/);
    const garbage = await rawMcp("not-a-token");
    expect(garbage.status).toBe(401);
  });

  it("user A cannot move or delete user B's mail, and deleting only moves to Trash", async () => {
    const a = await connect(fake, A);
    await connect(fake, B);
    const mine = fake.addMessage(A, { subject: "mine" });
    const theirs = fake.addMessage(B, { subject: "theirs" });
    const untouched = { ...fake.email(B, theirs.id)!.mailboxIds };

    const foreignDelete = await callTool(a.accessToken!, "delete_mail", { message_ids: [theirs.id] });
    expect(foreignDelete.isError).toBe(true);
    const foreignMove = await callTool(a.accessToken!, "move_mail", {
      message_ids: [theirs.id],
      folder_id: fake.folderId(A, "drafts"),
    });
    expect(foreignMove.isError).toBe(true);
    // B's folder as a target for A's own message: no such folder in A's mailbox.
    const intoForeign = await callTool(a.accessToken!, "move_mail", { message_ids: [mine.id], folder_id: theirs.folderId });
    expect(intoForeign.isError).toBe(true);
    expect(fake.email(B, theirs.id)!.mailboxIds).toEqual(untouched);
    expect(fake.email(A, mine.id)!.mailboxIds).toEqual({ [mine.folderId]: true });

    const deleted = await callTool(a.accessToken!, "delete_mail", { message_ids: [mine.id] });
    expect(deleted.isError).toBeFalsy();
    expect(structured(deleted)).toEqual({ folder_id: fake.folderId(A, "trash"), moved: 1, not_moved: [] });
    expect(fake.email(A, mine.id)).toMatchObject({ subject: "mine", mailboxIds: { [fake.folderId(A, "trash")!]: true } });
  });

  it("the same send_mail call twice over MCP delivers one message", async () => {
    const a = await connect(fake, A);
    const args = { to: ["ok@test.example"], subject: "Once", body: "Only one copy" };
    const first = await callTool(a.accessToken!, "send_mail", args);
    const second = await callTool(a.accessToken!, "send_mail", args);
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(structured(second).message_id).toBe(structured(first).message_id);
    const sent = fake.sent(A);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toEqual([expect.objectContaining({ email: A })]);
    expect(sent[0]!.subject).toBe("Once");
  });

  it("an unconfirmed send reaches the tool as its fixed message, is audited as an error and not repeated", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const a = await connect(fake, A);
    const args = { to: ["ok@test.example"], subject: "Maybe", body: "Did it go out?" };
    fake.failNextSubmit("accepted-then-503");
    const first = await callTool(a.accessToken!, "send_mail", args);
    expect(first).toEqual({ isError: true, content: [{ type: "text", text: MAIL_ERROR_MESSAGES.send_unconfirmed }] });
    const second = await callTool(a.accessToken!, "send_mail", args);
    expect(second.isError).toBe(true);
    expect(fake.sent(A)).toHaveLength(1);
    const { results } = await env.DB.prepare(
      "SELECT outcome, error_code FROM audit_log WHERE account_id = ? AND event = 'tool_call' ORDER BY id",
    )
      .bind(accountA)
      .all();
    expect(results).toEqual([
      { outcome: "error", error_code: "send_unconfirmed" },
      { outcome: "error", error_code: "send_unconfirmed" },
    ]);
  });

  it("removing the application at Stalwart ends access: reconnect_required, then 401, and no further upstream calls", async () => {
    const a = await connect(fake, A);
    expect((await callTool(a.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();

    fake.revokeGrant(A);
    const refused = await callTool(a.accessToken!, "list_mailboxes", {});
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain(MAIL_ERROR_MESSAGES.reconnect_required);

    const after = fake.requests.length;
    const again = await rawMcp(a.accessToken!);
    expect(again.status).toBe(401);
    const refresh = await send("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refreshToken!, client_id: a.clientId }).toString(),
    });
    expect(refresh.status).toBe(400);
    expect(fake.requests.length).toBe(after);
  });

  it("an orphaned grant (no vault connection) ends itself: reconnect_required, then 401", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const a = await connect(fake, A);
    // The connection is gone while the grant lives on (e.g. a revocation lost to KV lag).
    await dropConnection(accountA);
    const refused = await callTool(a.accessToken!, "list_mailboxes", {});
    expect(JSON.stringify(refused)).toContain(MAIL_ERROR_MESSAGES.reconnect_required);
    const again = await rawMcp(a.accessToken!);
    expect(again.status).toBe(401);
    expect(again.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(await grantDirectory(env, ORIGIN).hasGrants(accountA)).toBe(false);
  });

  it("the next sign-in revokes an orphaned grant; a second tool on a connected mailbox keeps the first working", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const first = await connect(fake, A, { clientName: "First" });
    const second = await connect(fake, A, { clientName: "Second" });
    expect((await callTool(first.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
    expect((await callTool(second.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();

    await dropConnection(accountA);
    const third = await connect(fake, A, { clientName: "Third" });
    expect((await rawMcp(first.accessToken!)).status).toBe(401);
    expect((await rawMcp(second.accessToken!)).status).toBe(401);
    expect((await callTool(third.accessToken!, "list_mailboxes", {})).isError).toBeFalsy();
  });

  it("a sign-in whose old grants cannot be revoked stores nothing and revokes the fresh Stalwart token", async () => {
    const accountA = fake.addMailbox(A).accountId;
    vi.spyOn(oauthOptions, "grantDirectory").mockReturnValue({
      hasGrants: async () => false,
      revokeAll: async () => {
        throw new Error("kv down");
      },
    });
    const c = await connect(fake, A);
    expect(c.responses.at(-1)!.status).toBe(500);
    expect(c.accessToken).toBeUndefined();
    expect((await vaultFor(env, accountA).status()).connected).toBe(false);
    const issued = fake.requests.filter((r) => r.url === STALWART.revoke);
    expect(issued).toHaveLength(1);
    expect(fake.revoked(A)).toBe(true);
  });

  it("publishes OAuth metadata with PKCE S256 and the registration endpoint", async () => {
    const res = await send("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.code_challenge_methods_supported).not.toContain("plain");
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(meta.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/token`);

    const resource = await send("/.well-known/oauth-protected-resource/mcp");
    expect(resource.status).toBe(200);
    expect(((await resource.json()) as { resource: string }).resource).toBe(`${ORIGIN}/mcp`);
  });
});
