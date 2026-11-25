import { MAIL_ERROR_MESSAGES, MailError } from "../src/mail";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSession, jmapCall, UpstreamAuthError, type JmapSession } from "../src/jmap/jmap-client";
import { JmapMailboxAdapter } from "../src/jmap/jmap-mailbox-adapter";
import { STALWART } from "../src/stalwart/endpoints";
import { createFakeStalwart, type FakeStalwart, type RecordedRequest } from "./fake-stalwart";

const A = "a@test.example";
const B = "b@test.example";
const EVIL = "https://evil.example";

let fake: FakeStalwart;
const allRequests: RecordedRequest[] = [];

beforeEach(() => {
  fake = createFakeStalwart();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  allRequests.push(...fake.requests);
  vi.unstubAllGlobals();
});

async function adapterFor(email: string): Promise<JmapMailboxAdapter> {
  const { accessToken } = fake.tokensFor(email);
  const session = await fetchSession(accessToken);
  return new JmapMailboxAdapter({ accountId: session.accountId, accessToken, session });
}

const jmapRequests = () => fake.requests.filter((r) => r.url === `${STALWART.origin}/jmap/`);
const methodNames = (r: RecordedRequest): string[] => r.body.methodCalls.map((c: [string]) => c[0]);

async function expectMailError(p: Promise<unknown>, code: string): Promise<MailError> {
  const error = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MailError);
  expect(error).toMatchObject({ code });
  return error as MailError;
}

describe("fetchSession", () => {
  it("takes the account id from primaryAccounts and the address from username", async () => {
    const { accountId } = fake.addMailbox(A);
    const session = await fetchSession(fake.tokensFor(A).accessToken);
    expect(session).toEqual({
      apiUrl: `${STALWART.origin}/jmap/`,
      accountId,
      username: A,
      // The test config offers contacts and calendars: the token has a scope for each.
      capabilities: [
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
        "urn:ietf:params:jmap:calendars",
        "urn:ietf:params:jmap:contacts",
      ],
    });
    expect(fake.requests[0]).toMatchObject({ url: STALWART.session, method: "GET" });
  });

  it("refuses a session whose apiUrl is on another origin and sends no token there", async () => {
    fake.addMailbox(A);
    const { accessToken } = fake.tokensFor(A);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      if (new Request(input, init).url !== STALWART.session) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return Response.json({ ...body, apiUrl: `${EVIL}/jmap/` });
    });
    await expectMailError(fetchSession(accessToken), "upstream_rejected");

    // An adapter built from such a session (e.g. a stored one) refuses before any request.
    const session: JmapSession = { apiUrl: `${EVIL}/jmap/`, accountId: "acc1", username: A, capabilities: [] };
    const adapter = new JmapMailboxAdapter({ accountId: "acc1", accessToken, session });
    await expectMailError(adapter.listMailboxes(), "upstream_rejected");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests.every((r) => r.url.startsWith(`${STALWART.origin}/`))).toBe(true);
  });

  it("never follows a redirect with the token attached", async () => {
    fake.addMailbox(A);
    const { accessToken } = fake.tokensFor(A);
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init);
      await fake.fetch(input, init);
      return new Response(null, { status: 302, headers: { Location: `${EVIL}/jmap/session` } });
    });
    await expectMailError(fetchSession(accessToken), "upstream_rejected");
    expect(inits[0]?.redirect).toBe("manual");
    expect(fake.requests.map((r) => r.url)).toEqual([STALWART.session]);
  });

  it("treats a session without a mail account as upstream_rejected", async () => {
    fake.addMailbox(A);
    const { accessToken } = fake.tokensFor(A);
    vi.stubGlobal("fetch", async () => Response.json({ apiUrl: `${STALWART.origin}/jmap/`, username: A }));
    await expectMailError(fetchSession(accessToken), "upstream_rejected");
  });
});

describe("JmapMailboxAdapter", () => {
  it("lists folders with role, total and unread", async () => {
    fake.addMailbox(A);
    fake.addMessage(A, { subject: "one" });
    fake.addMessage(A, { subject: "two", unread: false });
    const a = await adapterFor(A);
    const { folders } = await a.listMailboxes();
    const inbox = folders.find((f) => f.role === "inbox");
    expect(inbox).toEqual({ id: fake.folderId(A, "inbox"), name: "Inbox", role: "inbox", parent_id: null, total: 2, unread: 1 });
    expect(folders.map((f) => f.role)).toEqual(["inbox", "drafts", "sent", "trash"]);
  });

  it("searches newest first, caps the page and reports next_offset", async () => {
    fake.addMailbox(A);
    for (let i = 0; i < 30; i++) fake.addMessage(A, { subject: `m${i}` });
    const a = await adapterFor(A);
    const first = await a.searchMail({ limit: 25, offset: 0 });
    expect(first.messages).toHaveLength(25);
    expect(first.messages[0]?.subject).toBe("m29");
    expect(first.messages[24]?.subject).toBe("m5");
    expect(first.next_offset).toBe(25);
    const second = await a.searchMail({ limit: 25, offset: 25 });
    expect(second.messages.map((m) => m.subject)).toEqual(["m4", "m3", "m2", "m1", "m0"]);
    expect(second.next_offset).toBeNull();

    // One request per page: Email/query and Email/get by back-reference.
    const [query, get] = jmapRequests()[0]!.body.methodCalls;
    expect(query).toEqual([
      "Email/query",
      expect.objectContaining({ sort: [{ property: "receivedAt", isAscending: false }], limit: 26, position: 0 }),
      expect.any(String),
    ]);
    expect(get[0]).toBe("Email/get");
    expect(get[1]["#ids"]).toEqual({ resultOf: query[2], name: "Email/query", path: "/ids" });
  });

  it("maps search filters and flags", async () => {
    fake.addMailbox(A);
    fake.addMessage(A, { subject: "read", unread: false, flagged: true, keywords: ["$answered"] });
    const hit = fake.addMessage(A, {
      subject: "Invoice 7",
      from: [{ name: "Shop", email: "shop@x.example" }],
      attachments: [{ name: "inv.pdf", size: 10, type: "application/pdf" }],
    });
    const a = await adapterFor(A);
    const r = await a.searchMail({
      from: "shop@",
      subject: "invoice",
      unread: true,
      has_attachment: true,
      folder_id: hit.folderId,
      after: "2025-01-01T02:00:00+02:00",
      before: "2026-12-31T19:00:00-05:00",
      limit: 10,
      offset: 0,
    });
    expect(r.messages.map((m) => m.id)).toEqual([hit.id]);
    expect(r.messages[0]).toMatchObject({
      thread_id: hit.threadId,
      folder_ids: [hit.folderId],
      from: [{ name: "Shop", email: "shop@x.example" }],
      unread: true,
      flagged: false,
      answered: false,
      draft: false,
      has_attachment: true,
    });
    const query = (r: RecordedRequest) => r.body.methodCalls.find((c: [string]) => c[0] === "Email/query")[1];
    // JMAP wants UTC dates: the offsets of the input are normalised.
    expect(query(jmapRequests()[0]!).filter).toEqual({
      from: "shop@",
      subject: "invoice",
      notKeyword: "$seen",
      hasAttachment: true,
      inMailbox: hit.folderId,
      after: "2025-01-01T00:00:00.000Z",
      before: "2027-01-01T00:00:00.000Z",
    });

    const read = await a.searchMail({ unread: false, text: "read", limit: 10, offset: 0 });
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]).toMatchObject({ unread: false, flagged: true, answered: true });
    expect(jmapRequests()[1]!.body.methodCalls[0][1].filter).toEqual({ text: "read", hasKeyword: "$seen" });
  });

  it("cuts previews to 200 characters and strips control characters from subjects", async () => {
    fake.addMailbox(A);
    fake.addMessage(A, {
      subject: "Hel\u0007lo\u202E\u200B world",
      preview: "p".repeat(256),
      from: [{ name: "Ev\u202Eil", email: "e@x.example" }],
    });
    const a = await adapterFor(A);
    const [m] = (await a.searchMail({ limit: 10, offset: 0 })).messages;
    expect(m?.subject).toBe("Hello world");
    expect(m?.preview).toBe("p".repeat(200));
    expect(m?.from[0]?.name).toBe("Evil");
  });

  it("reads a conversation oldest first with attachment names and sizes", async () => {
    fake.addMailbox(A);
    const first = fake.addMessage(A, { subject: "Plan", body: "first", cc: [{ name: null, email: "c@x.example" }] });
    fake.addMessage(A, {
      subject: "Re: Plan",
      body: "second",
      threadId: first.threadId,
      attachments: [{ name: "plan.pdf", size: 1234, type: "application/pdf" }],
    });
    const a = await adapterFor(A);
    const r = await a.readThread({ thread_id: first.threadId });
    expect(r.thread_id).toBe(first.threadId);
    expect(r.omitted_messages).toBe(0);
    expect(r.messages.map((m) => m.body)).toEqual(["first", "second"]);
    expect(r.messages[0]).toMatchObject({ id: first.id, subject: "Plan", cc: [{ name: null, email: "c@x.example" }], body_truncated: false, attachments: [] });
    expect(r.messages[1]?.attachments).toEqual([{ name: "plan.pdf", size: 1234, type: "application/pdf" }]);
    const get = jmapRequests().at(-1)!.body.methodCalls[0][1];
    expect(get).toMatchObject({ fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 262144 });
  });

  it("returns at most 25 messages of a 300-message conversation and counts the rest", async () => {
    fake.addMailbox(A);
    const first = fake.addMessage(A, { subject: "m0" });
    for (let i = 1; i < 300; i++) fake.addMessage(A, { subject: `m${i}`, threadId: first.threadId });
    const a = await adapterFor(A);
    const r = await a.readThread({ thread_id: first.threadId });
    expect(r.messages).toHaveLength(25);
    expect(r.omitted_messages).toBe(275);
    expect(r.messages[0]?.subject).toBe("m275");
    expect(r.messages[24]?.subject).toBe("m299");
  });

  it("turns a 2 MB HTML-only body into at most 20,000 characters of text and marks it", async () => {
    fake.addMailbox(A);
    const m = fake.addMessage(A, { html: "<p>" + "word ".repeat(400_000) + "</p>" });
    const a = await adapterFor(A);
    const r = await a.readThread({ thread_id: m.threadId });
    expect(r.messages[0]!.body.length).toBeLessThanOrEqual(20_000);
    expect(r.messages[0]!.body.startsWith("word word")).toBe(true);
    expect(r.messages[0]!.body).not.toContain("<");
    expect(r.messages[0]!.body_truncated).toBe(true);
  });

  it("strips bidi and control characters from an HTML body, literal and as entities", async () => {
    fake.addMailbox(A);
    const m = fake.addMessage(A, { html: "<p>a\u202Eb\u0007c&#8238;d&#7;e&#x202E;f&#x7;g</p>" });
    const a = await adapterFor(A);
    const body = (await a.readThread({ thread_id: m.threadId })).messages[0]!.body;
    expect(body).toBe("abcdefg");
  });

  it("prefers the text part over the HTML part", async () => {
    fake.addMailbox(A);
    const m = fake.addMessage(A, { body: "plain version", html: "<p>html version</p>" });
    const a = await adapterFor(A);
    expect((await a.readThread({ thread_id: m.threadId })).messages[0]!.body).toBe("plain version");
  });

  it("answers not_found for another mailbox's message, thread and folder ids", async () => {
    const a = await adapterFor(A);
    const b = fake.addMessage(B, { subject: "secret" });
    await expect(a.readThread({ thread_id: b.threadId })).rejects.toMatchObject({ code: "not_found" });
    await expect(a.createDraft({ to: [], cc: [], bcc: [], body: "x", in_reply_to: b.id })).rejects.toMatchObject({ code: "not_found" });
    expect((await a.searchMail({ folder_id: b.folderId, limit: 10, offset: 0 })).messages).toEqual([]);
    expect(JSON.stringify(fake.requests)).not.toContain("secret");
  });

  it("answers an empty page only for a folder that is not this account's; other errors surface", async () => {
    fake.addMailbox(A);
    const own = fake.addMessage(A, { subject: "mine" });
    const b = fake.addMessage(B, { subject: "secret" });
    const a = await adapterFor(A);
    // A foreign folder whose query Stalwart refuses as invalid: still an empty page.
    const invalidQuery = () =>
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await fake.fetch(input, init);
        if (typeof init?.body !== "string" || !init.body.includes("Email/query")) return res;
        const body = (await res.json()) as { methodResponses: [string, unknown, string][] };
        const methodResponses = body.methodResponses.map((r) =>
          r[2] === "q" ? ["error", { type: "invalidArguments", description: "upstream detail" }, "q"] : r,
        );
        return Response.json({ ...body, methodResponses });
      });
    invalidQuery();
    expect(await a.searchMail({ folder_id: b.folderId, limit: 10, offset: 0 })).toEqual({ messages: [], next_offset: null });
    // The same error for one of this account's folders is a real error.
    await expectMailError(a.searchMail({ folder_id: own.folderId, limit: 10, offset: 0 }), "upstream_rejected");
    await expectMailError(a.searchMail({ text: "x", limit: 10, offset: 0 }), "upstream_rejected");
  });

  it("refuses to construct when the session's account differs from the grant's", async () => {
    fake.addMailbox(A);
    const t = fake.tokensFor(A).accessToken;
    const session = await fetchSession(t);
    expect(() => new JmapMailboxAdapter({ accountId: "other", accessToken: t, session })).toThrow(
      expect.objectContaining({ code: "account_mismatch" }),
    );
  });

  it("sends every JMAP call with the constructor's account id", async () => {
    const { accountId: accountA } = fake.addMailbox(A);
    fake.addMailbox(B);
    const m = fake.addMessage(A, { subject: "hello" });
    const a = await adapterFor(A);
    await a.listMailboxes();
    await a.searchMail({ text: "hello", limit: 10, offset: 0 });
    await a.readThread({ thread_id: m.threadId });
    await a.createDraft({ to: ["ok@test.example"], cc: [], bcc: [], subject: "d", body: "b" });
    await a.createDraft({ to: [], cc: [], bcc: [], body: "b", in_reply_to: m.id });
    await a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" });
    const requests = jmapRequests();
    expect(requests.length).toBeGreaterThanOrEqual(6);
    for (const r of requests) {
      expect(r.authorization).toBe(`Bearer ${fake.tokensFor(A).accessToken}`);
      for (const [, args] of r.body.methodCalls) expect(args.accountId).toBe(accountA);
    }
  });

  it("sends the JMAP capabilities and a JSON content type", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    const seen: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return fake.fetch(input, init);
    });
    await a.listMailboxes();
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(seen[0]?.redirect).toBe("manual");
    expect(fake.requests.at(-1)!.body.using).toEqual([
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ]);
  });

  it("creates a draft in Drafts with $draft and $seen and the identity as From", async () => {
    fake.addMailbox(A, { identity: { name: "Alice A" } });
    const a = await adapterFor(A);
    const r = await a.createDraft({ to: ["x@y.example"], cc: ["c@y.example"], bcc: [], subject: "Hi", body: "Hello" });
    expect(r.folder_id).toBe(fake.folderId(A, "drafts"));
    const draft = fake.email(A, r.draft_id);
    expect(draft).toMatchObject({
      mailboxIds: { [r.folder_id]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: "Alice A", email: A }],
      to: [{ name: null, email: "x@y.example" }],
      cc: [{ name: null, email: "c@y.example" }],
      subject: "Hi",
      text: "Hello",
    });
    expect(fake.sent(A)).toEqual([]);
  });

  it("sets From to the mailbox's own address from Identity/get", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    await a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" });
    expect(fake.sent(A)[0]!.from).toEqual([{ name: expect.anything(), email: A }]);
  });

  it("matches the identity case-insensitively and never uses another identity", async () => {
    fake.addMailbox(A, { identity: { email: "A@Test.Example" } });
    const a = await adapterFor(A);
    await a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" });
    expect(fake.sent(A)[0]!.from[0]!.email).toBe("A@Test.Example");
  });

  it("refuses to send when no identity matches the mailbox address", async () => {
    fake.addMailbox(A, { identity: { email: "someone-else@test.example" } });
    const a = await adapterFor(A);
    await expectMailError(a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" }), "no_identity");
    await expectMailError(a.createDraft({ to: [], cc: [], bcc: [], subject: "s", body: "b" }), "no_identity");
    expect(fake.sent(A)).toEqual([]);
    expect(jmapRequests().flatMap(methodNames)).not.toContain("Email/set");
  });

  it("refuses to send when the mailbox has no identity at all", async () => {
    fake.addMailbox(A, { identity: false });
    const a = await adapterFor(A);
    await expectMailError(a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" }), "no_identity");
  });

  it("moves the sent copy to Sent and creates exactly one submission", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    const r = await a.sendMail({ to: ["ok@test.example"], cc: ["c@test.example"], bcc: ["b@test.example"], subject: "s", body: "b" });
    expect(r).toEqual({ message_id: expect.any(String), recipients: 3, deduplicated: false });
    expect(fake.sent(A)).toHaveLength(1);
    expect(fake.sent(A)[0]).toMatchObject({ emailId: r.message_id, subject: "s", text: "b" });
    const stored = fake.email(A, r.message_id)!;
    expect(stored.mailboxIds).toEqual({ [fake.folderId(A, "sent")!]: true });
    expect(stored.keywords).toEqual({ $seen: true });

    // Email/set create and EmailSubmission/set create in one request, no envelope.
    const sendRequest = jmapRequests().find((q) => methodNames(q).includes("EmailSubmission/set"))!;
    expect(methodNames(sendRequest)).toEqual(["Email/set", "EmailSubmission/set"]);
    const submission = sendRequest.body.methodCalls[1][1];
    const [[cid, create]] = Object.entries(submission.create) as [[string, Record<string, unknown>]];
    expect(create).toEqual({ identityId: expect.any(String), emailId: "#draft" });
    expect(Object.keys(submission.onSuccessUpdateEmail)).toEqual([`#${cid}`]);
  });

  it("leaves the draft and answers send_failed when the submission is rejected", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    fake.failNext("submission-rejected");
    await expectMailError(a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" }), "send_failed");
    expect(fake.sent(A)).toEqual([]);
    const drafts = fake.folderId(A, "drafts")!;
    const left = (await a.searchMail({ folder_id: drafts, limit: 10, offset: 0 })).messages;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ subject: "s", draft: true });
  });

  it("answers send_unconfirmed when the submit request's outcome is unknown", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    const send = (body: string) => a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body });

    // Accepted, then a 5xx, an unparseable body, or no method responses: the mail did go out.
    fake.failNextSubmit("accepted-then-503");
    const unconfirmed = await expectMailError(send("one"), "send_unconfirmed");
    expect(unconfirmed.message).toBe(MAIL_ERROR_MESSAGES.send_unconfirmed);
    expect(unconfirmed.message).not.toContain("fake-stalwart");
    fake.failNextSubmit("accepted-then-invalid-json");
    await expectMailError(send("two"), "send_unconfirmed");
    fake.failNextSubmit("accepted-then-empty");
    await expectMailError(send("three"), "send_unconfirmed");
    expect(fake.sent(A)).toHaveLength(3);

    // A network failure or timeout on the submit request is just as unknown.
    fake.failNextSubmit("network");
    await expectMailError(send("four"), "send_unconfirmed");
    expect(fake.sent(A)).toHaveLength(3);
  });

  it("keeps the definite answers of the submit request and the error mapping before it", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    const send = () => a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" });
    const onSubmit = (res: () => Response) =>
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const isSubmit = typeof init?.body === "string" && init.body.includes("EmailSubmission/set");
        return isSubmit ? res() : fake.fetch(input, init);
      });

    // A 401 on the submit request: not processed, the vault may refresh and retry.
    onSubmit(() => new Response("fake-stalwart: unauthorized", { status: 401 }));
    await expect(send()).rejects.toBeInstanceOf(UpstreamAuthError);
    // Any other 4xx: not processed.
    onSubmit(() => new Response("fake-stalwart: bad request", { status: 400 }));
    await expectMailError(send(), "upstream_rejected");
    // A method error for the submission: not processed.
    onSubmit(() =>
      Response.json({
        methodResponses: [
          ["Email/set", { created: { draft: { id: "em900" } } }, "d"],
          ["error", { type: "serverFail" }, "s"],
        ],
      }),
    );
    await expectMailError(send(), "send_failed");
    vi.stubGlobal("fetch", fake.fetch);
    expect(fake.sent(A)).toEqual([]);

    // Failures before the submit request keep their codes.
    fake.failNext("http-503");
    await expectMailError(send(), "upstream_unavailable");
    fake.failNext("network");
    await expectMailError(send(), "upstream_unavailable");
    expect(fake.sent(A)).toEqual([]);
  });

  it("copies only well-formed message ids of the original into In-Reply-To and References", async () => {
    fake.addMailbox(A);
    const hostile = "a>\r\nBcc: x@y.example";
    const many = Array.from({ length: 30 }, (_, i) => `r${i}@x.example`);
    const original = fake.addMessage(A, {
      subject: "Hi",
      messageId: hostile,
      references: ["ok@x.example", hostile, "has space@x.example", "<angled@x.example>", "x".repeat(251), ...many],
    });
    const a = await adapterFor(A);
    const draft = await a.createDraft({ to: [], cc: [], bcc: [], body: "b", in_reply_to: original.id });
    const stored = fake.email(A, draft.draft_id)!;
    // The original's own id is dropped, so there is nothing to reply to: no threading headers.
    expect(stored.inReplyTo).toBeNull();
    expect(stored.references).toBeNull();

    const clean = fake.addMessage(A, { subject: "Hi", messageId: "orig@x.example", references: [hostile, ...many] });
    const reply = await a.createDraft({ to: [], cc: [], bcc: [], body: "b", in_reply_to: clean.id });
    const replied = fake.email(A, reply.draft_id)!;
    expect(replied.inReplyTo).toEqual(["orig@x.example"]);
    expect(replied.references).toEqual([...many.slice(-19), "orig@x.example"]);
    expect(JSON.stringify(replied)).not.toContain("Bcc");
  });

  it("moves messages into a folder of the account and takes them out of every other folder", async () => {
    const one = fake.addMessage(A, { subject: "one" });
    const two = fake.addMessage(A, { subject: "two", folder: "sent" });
    const a = await adapterFor(A);
    const drafts = fake.folderId(A, "drafts")!;
    expect(await a.moveMail({ message_ids: [one.id, two.id, one.id], target: { folder_id: drafts } })).toEqual({
      folder_id: drafts,
      moved: 2,
      not_moved: [],
    });
    expect(fake.email(A, one.id)!.mailboxIds).toEqual({ [drafts]: true });
    expect(fake.email(A, two.id)!.mailboxIds).toEqual({ [drafts]: true });
    // Moving again changes nothing and still succeeds.
    expect((await a.moveMail({ message_ids: [one.id], target: { folder_id: drafts } })).moved).toBe(1);
    expect(fake.email(A, one.id)!.mailboxIds).toEqual({ [drafts]: true });
  });

  it("deleting moves to Trash: the message still exists and nothing is ever destroyed", async () => {
    const m = fake.addMessage(A, { subject: "keep me" });
    const a = await adapterFor(A);
    const trash = fake.folderId(A, "trash")!;
    expect(await a.moveMail({ message_ids: [m.id], target: { role: "trash" } })).toEqual({
      folder_id: trash,
      moved: 1,
      not_moved: [],
    });
    expect(fake.email(A, m.id)).toMatchObject({ subject: "keep me", mailboxIds: { [trash]: true } });
    // It can be brought back.
    await a.moveMail({ message_ids: [m.id], target: { folder_id: m.folderId } });
    expect(fake.email(A, m.id)!.mailboxIds).toEqual({ [m.folderId]: true });
    for (const r of jmapRequests()) {
      for (const [name, args] of r.body.methodCalls as [string, Record<string, unknown>][]) {
        expect(args.destroy).toBeUndefined();
        expect(args.onSuccessDestroyEmail).toBeUndefined();
        if (name.endsWith("/set")) expect(name).toBe("Email/set");
      }
    }
  });

  it("moves nothing of another mailbox: foreign message ids are reported, a foreign folder is not found", async () => {
    const own = fake.addMessage(A, { subject: "mine" });
    const foreign = fake.addMessage(B, { subject: "secret" });
    const a = await adapterFor(A);
    const before = { ...fake.email(B, foreign.id)!.mailboxIds };

    await expectMailError(a.moveMail({ message_ids: [foreign.id], target: { role: "trash" } }), "not_found");
    expect(await a.moveMail({ message_ids: [own.id, foreign.id], target: { role: "trash" } })).toEqual({
      folder_id: fake.folderId(A, "trash"),
      moved: 1,
      not_moved: [foreign.id],
    });
    expect(fake.email(B, foreign.id)!.mailboxIds).toEqual(before);

    // B's folder id is no folder of A: refused before any message is touched.
    const requests = jmapRequests().length;
    await expectMailError(a.moveMail({ message_ids: [own.id], target: { folder_id: foreign.folderId } }), "not_found");
    expect(jmapRequests().slice(requests).flatMap(methodNames)).toEqual(["Mailbox/get"]);
    expect(fake.email(A, own.id)!.mailboxIds).toEqual({ [fake.folderId(A, "trash")!]: true });
    expect(JSON.stringify(fake.requests)).not.toContain("secret");
  });

  it("move by folder id refuses the Trash folder: only a delete request goes there", async () => {
    const m = fake.addMessage(A, { subject: "stay" });
    const a = await adapterFor(A);
    const requests = jmapRequests().length;
    await expectMailError(
      a.moveMail({ message_ids: [m.id], target: { folder_id: fake.folderId(A, "trash")! } }),
      "invalid_input",
    );
    expect(jmapRequests().slice(requests).flatMap(methodNames)).toEqual(["Mailbox/get"]);
    expect(fake.email(A, m.id)!.mailboxIds).toEqual({ [m.folderId]: true });
  });

  /** Answers as the fake does, but rewrites the `Email/set` answer of a move. */
  function rewriteMoveAnswer(change: (args: { updated: Record<string, null> | null; notUpdated: Record<string, unknown> | null }) => void) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      const sent = init?.body === undefined ? "" : String(init.body);
      if (!sent.includes('"Email/set"')) return res;
      const body = (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
      for (const r of body.methodResponses) if (r[0] === "Email/set") change(r[1] as never);
      return Response.json(body);
    });
  }

  it("reports what moved when the server refuses some messages for another reason", async () => {
    const one = fake.addMessage(A, { subject: "one" });
    const two = fake.addMessage(A, { subject: "two" });
    const a = await adapterFor(A);
    rewriteMoveAnswer((args) => {
      delete args.updated![two.id];
      args.notUpdated = { [two.id]: { type: "forbidden" } };
    });
    expect(await a.moveMail({ message_ids: [one.id, two.id], target: { role: "trash" } })).toEqual({
      folder_id: fake.folderId(A, "trash"),
      moved: 1,
      not_moved: [two.id],
    });
    // Nothing moved and the reason is not "no such message": that is the server's refusal.
    rewriteMoveAnswer((args) => {
      args.updated = null;
      args.notUpdated = { [one.id]: { type: "forbidden" } };
    });
    await expectMailError(a.moveMail({ message_ids: [one.id], target: { folder_id: one.folderId } }), "upstream_rejected");
  });

  it("an id the server's answer does not mention counts as not moved, never as moved", async () => {
    const one = fake.addMessage(A, { subject: "one" });
    const two = fake.addMessage(A, { subject: "two" });
    const a = await adapterFor(A);
    rewriteMoveAnswer((args) => {
      delete args.updated![two.id];
    });
    expect(await a.moveMail({ message_ids: [one.id, two.id], target: { role: "trash" } })).toMatchObject({
      moved: 1,
      not_moved: [two.id],
    });
    rewriteMoveAnswer((args) => {
      args.updated = null;
      args.notUpdated = null;
    });
    await expectMailError(a.moveMail({ message_ids: [one.id], target: { folder_id: one.folderId } }), "not_found");
  });

  it("answers mailbox_unsupported for a delete when the mailbox has no Trash folder", async () => {
    fake.addMailbox(A, { trash: false });
    const m = fake.addMessage(A, { subject: "stay" });
    const a = await adapterFor(A);
    await expectMailError(a.moveMail({ message_ids: [m.id], target: { role: "trash" } }), "mailbox_unsupported");
    expect(fake.email(A, m.id)!.mailboxIds).toEqual({ [m.folderId]: true });
  });

  it("answers mailbox_unsupported without a Drafts folder", async () => {
    fake.addMailbox(A, { drafts: false });
    const a = await adapterFor(A);
    await expectMailError(a.createDraft({ to: [], cc: [], bcc: [], subject: "s", body: "b" }), "mailbox_unsupported");
    await expectMailError(a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" }), "mailbox_unsupported");
    expect(fake.sent(A)).toEqual([]);
  });

  it("sends and keeps the copy in Drafts (no $draft) without a Sent folder", async () => {
    fake.addMailbox(A, { sent: false });
    const a = await adapterFor(A);
    const r = await a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], subject: "s", body: "b" });
    expect(fake.sent(A)).toHaveLength(1);
    const stored = fake.email(A, r.message_id)!;
    expect(stored.mailboxIds).toEqual({ [fake.folderId(A, "drafts")!]: true });
    expect(stored.keywords).toEqual({ $seen: true });
  });

  it("sets In-Reply-To and References and a Re: subject on a reply", async () => {
    fake.addMailbox(A);
    const original = fake.addMessage(A, {
      subject: "Quote\u0007 request",
      messageId: "orig@x.example",
      references: ["root@x.example"],
    });
    const a = await adapterFor(A);
    const draft = await a.createDraft({ to: ["x@y.example"], cc: [], bcc: [], body: "Sure", in_reply_to: original.id });
    expect(fake.email(A, draft.draft_id)).toMatchObject({
      subject: "Re: Quote request",
      inReplyTo: ["orig@x.example"],
      references: ["root@x.example", "orig@x.example"],
      threadId: original.threadId,
    });

    const already = fake.addMessage(A, { subject: "RE: Offer", messageId: "o2@x.example" });
    await a.sendMail({ to: ["ok@test.example"], cc: [], bcc: [], body: "b", in_reply_to: already.id });
    expect(fake.sent(A)[0]).toMatchObject({ subject: "RE: Offer", inReplyTo: ["o2@x.example"], references: ["o2@x.example"] });

    const own = await a.createDraft({ to: [], cc: [], bcc: [], subject: "Own subject", body: "b", in_reply_to: original.id });
    expect(fake.email(A, own.draft_id)?.subject).toBe("Own subject");
  });

  it("maps 401 to UpstreamAuthError and 503 to upstream_unavailable without upstream text", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    fake.failNext("http-401");
    const auth = await a.listMailboxes().catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(UpstreamAuthError);
    expect(String((auth as Error).message)).not.toContain("fake-stalwart");

    fake.failNext("http-503");
    const unavailable = await expectMailError(a.listMailboxes(), "upstream_unavailable");
    expect(unavailable.message).toBe(MAIL_ERROR_MESSAGES.upstream_unavailable);

    fake.failNext("network");
    await expectMailError(a.searchMail({ limit: 10, offset: 0 }), "upstream_unavailable");

    fake.failNext("invalid-json");
    const rejected = await expectMailError(a.listMailboxes(), "upstream_rejected");
    expect(rejected.message).toBe(MAIL_ERROR_MESSAGES.upstream_rejected);

    fake.failNext("http-401");
    await expect(fetchSession(fake.tokensFor(A).accessToken)).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  it("maps an expired access token to UpstreamAuthError", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    fake.expireAccessToken(A);
    await expect(a.listMailboxes()).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  it("gives every upstream request a 10 s timeout and maps a timeout to upstream_unavailable", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expectMailError(a.listMailboxes(), "upstream_unavailable");
    expect(timeout).toHaveBeenCalledWith(10_000);
    timeout.mockRestore();
  });

  it("answers upstream_rejected for a method error and for a missing method response", async () => {
    fake.addMailbox(A);
    const a = await adapterFor(A);
    vi.stubGlobal("fetch", async () =>
      Response.json({ methodResponses: [["error", { type: "serverFail", description: "upstream detail" }, "m"]] }),
    );
    const failed = await expectMailError(a.listMailboxes(), "upstream_rejected");
    expect(failed.message).not.toContain("upstream detail");
    vi.stubGlobal("fetch", async () => Response.json({ methodResponses: [] }));
    await expectMailError(a.listMailboxes(), "upstream_rejected");
    vi.stubGlobal("fetch", async () => Response.json({ methodResponses: [["Mailbox/get", { list: "nope" }, "m"]] }));
    await expectMailError(a.listMailboxes(), "upstream_rejected");
  });

  it("jmapCall returns the method responses in order", async () => {
    const { accountId } = fake.addMailbox(A);
    const { accessToken } = fake.tokensFor(A);
    const session = await fetchSession(accessToken);
    const responses = await jmapCall(session, accessToken, [
      ["Mailbox/get", { accountId, ids: [] }, "0"],
      ["Mailbox/get", { accountId: "acc999", ids: [] }, "1"],
    ]);
    expect(responses.map((r) => [r[0], r[2]])).toEqual([["Mailbox/get", "0"], ["error", "1"]]);
    expect(responses[1]![1]).toEqual({ type: "accountNotFound" });
  });
});

// The adapter never deletes, never touches Sieve, vacation responses or identities, and uses
// no `/set` method other than Email/set create/update and EmailSubmission/set create.
afterAll(() => {
  const ALLOWED = new Set(["Mailbox/get", "Email/query", "Email/get", "Thread/get", "Identity/get", "Email/set", "EmailSubmission/set"]);
  const calls = allRequests
    .filter((r) => r.url === `${STALWART.origin}/jmap/` && Array.isArray(r.body?.methodCalls))
    .flatMap((r) => r.body.methodCalls as [string, Record<string, unknown>, string][]);
  const names = new Set(calls.map(([name]) => name));
  expect(names).toEqual(ALLOWED);
  for (const [name, args] of calls) {
    expect(ALLOWED.has(name)).toBe(true);
    if (name === "Email/set") {
      expect(args).not.toHaveProperty("destroy");
      expect(Object.keys(args).every((k) => ["accountId", "create", "update"].includes(k))).toBe(true);
    }
    if (name === "EmailSubmission/set") {
      expect(Object.keys(args).sort()).toEqual(["accountId", "create", "onSuccessUpdateEmail"]);
    }
  }
});
