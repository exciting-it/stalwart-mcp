import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAIL_LIMITS, MailError, type MailErrorCode, type OutgoingMessage } from "../src/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import { sendFingerprint } from "../src/vault/limits";
import { type MailboxVault, vaultFor } from "../src/vault/mailbox-vault";
import { VaultMailbox } from "../src/vault/vault-mailbox";
import { STALWART } from "../src/stalwart/endpoints";
import { createFakeStalwart, type FakeStalwart, type RecordedRequest } from "./fake-stalwart";

/**
 * HTML on `send_mail` and `create_draft`: sanitized in the vault, sent as text/plain plus
 * text/html, deduplicated over both. Runs through `VaultMailbox` and the vault, as the tools do.
 */

const ORIGIN = "https://mail-mcp.test.example";
const A = "a@test.example";
/** The only recipient on the test SEND_ALLOWLIST. */
const OK = "ok@test.example";
const T0 = 1_800_000_000_000;

type Stub = DurableObjectStub<MailboxVault>;

let fake: FakeStalwart;
let testNo = 0;

// Storage persists across the tests of this file: filler mailboxes give every test its own vault.
beforeEach(() => {
  testNo++;
  fake = createFakeStalwart();
  for (let i = 0; i < testNo * 10; i++) fake.addMailbox(`filler${i}@filler.example`);
  vi.stubGlobal("fetch", fake.fetch);
  vi.spyOn(clock, "now").mockImplementation(() => T0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const msg: OutgoingMessage = { to: [OK], cc: [], bcc: [], subject: "Hello" };

const HTML =
  '<h1 style="color:red">Report</h1><p onclick="steal()">Hello <b>Bob</b>, see <a href="https://example.org/r" target="_blank">the report</a>.</p>' +
  '<script>alert(1)</script><img src="https://tracker.example/p.gif"><ul><li>one</li><li>two</li></ul>';
const CLEAN =
  '<h1>Report</h1><p>Hello <b>Bob</b>, see <a href="https://example.org/r">the report</a>.</p><ul><li>one</li><li>two</li></ul>';
const CLEAN_TEXT = "Report\nHello Bob, see the report <https://example.org/r>.\none\ntwo";

async function signIn(email: string): Promise<{ stub: Stub; accountId: string; box: VaultMailbox }> {
  const accountId = fake.addMailbox(email).accountId;
  const stub = vaultFor(env, accountId);
  await stub.storeTokens({ accountId, email, origin: ORIGIN, ...fake.tokensFor(email) });
  return { stub, accountId, box: new VaultMailbox(env, accountId, email) };
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

const jmapRequests = () => fake.requests.filter((r) => r.url === `${STALWART.origin}/jmap/`);

/** The `Email/set` create of the latest request that has one. */
function lastEmailCreate(): Record<string, unknown> {
  const calls = jmapRequests().flatMap((r: RecordedRequest) => r.body.methodCalls as [string, Record<string, unknown>][]);
  const sets = calls.filter(([name, args]) => name === "Email/set" && args.create !== undefined);
  const create = sets.at(-1)![1].create as Record<string, Record<string, unknown>>;
  return create.draft!;
}

function sendsCounted(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (_v: MailboxVault, state) => {
    const row = state.storage.sql.exec("SELECT count FROM usage_counter WHERE name = 'send'").toArray()[0];
    return row ? Number(row.count) : 0;
  });
}

describe("send_mail with html", () => {
  it("sends text/plain and text/html, the HTML sanitized and the text as given", async () => {
    const { box } = await signIn(A);
    await box.sendMail({ ...msg, body: "Plain version", html: HTML });
    const create = lastEmailCreate();
    expect(create.bodyValues).toEqual({ body: { value: "Plain version" }, html: { value: CLEAN } });
    expect(create.textBody).toEqual([{ partId: "body", type: "text/plain" }]);
    expect(create.htmlBody).toEqual([{ partId: "html", type: "text/html" }]);
    expect(fake.sent(A)).toHaveLength(1);
    expect(fake.sent(A)[0]).toMatchObject({ text: "Plain version", html: CLEAN });
  });

  it("makes the text part from the sanitized HTML when body is omitted", async () => {
    const { box } = await signIn(A);
    await box.sendMail({ ...msg, html: HTML });
    expect(lastEmailCreate().bodyValues).toEqual({ body: { value: CLEAN_TEXT }, html: { value: CLEAN } });
    expect(fake.sent(A)[0]).toMatchObject({ text: CLEAN_TEXT, html: CLEAN });
  });

  it("without html sends exactly the request it sent before: one text/plain part", async () => {
    const { box } = await signIn(A);
    await box.sendMail({ ...msg, body: "Hi there" });
    const create = lastEmailCreate();
    const mailboxIds = create.mailboxIds as Record<string, true>;
    const from = create.from as unknown[];
    expect(JSON.stringify(create)).toBe(
      JSON.stringify({
        mailboxIds,
        keywords: { $draft: true, $seen: true },
        from,
        subject: "Hello",
        bodyValues: { body: { value: "Hi there" } },
        textBody: [{ partId: "body", type: "text/plain" }],
        to: [{ name: null, email: OK }],
      }),
    );
    expect(fake.sent(A)[0]).toMatchObject({ text: "Hi there", html: null });
  });

  it("is read back through read_thread as text", async () => {
    const { box } = await signIn(A);
    const sent = await box.sendMail({ ...msg, html: HTML });
    const threadId = fake.email(A, sent.message_id)!.threadId;
    const thread = await box.readThread({ thread_id: threadId });
    expect(thread.messages.map((m) => m.body)).toEqual([CLEAN_TEXT]);
  });

  it("refuses neither body nor html before the mailbox is touched", async () => {
    const { stub, box } = await signIn(A);
    const before = fake.requests.length;
    await expectCode(box.sendMail({ ...msg }), "invalid_input");
    await expectCode(box.createDraft({ ...msg }), "invalid_input");
    expect(fake.requests).toHaveLength(before);
    expect(await sendsCounted(stub)).toBe(0);
  });

  it("refuses HTML over the limit before the mailbox is touched", async () => {
    const { box } = await signIn(A);
    const before = fake.requests.length;
    const html = "<p>" + "x".repeat(MAIL_LIMITS.htmlInputChars - 3);
    expect(html.length).toBe(MAIL_LIMITS.htmlInputChars);
    await expectCode(box.sendMail({ ...msg, html: `${html}x` }), "invalid_input");
    await expectCode(box.createDraft({ ...msg, html: `${html}x` }), "invalid_input");
    expect(fake.requests).toHaveLength(before);
    expect(await box.sendMail({ ...msg, html })).toMatchObject({ deduplicated: false });
  });

  it("refuses HTML that sanitizes to nothing visible when no body is given: nothing sent or counted", async () => {
    const { stub, box } = await signIn(A);
    const before = fake.requests.length;
    for (const html of ["<script>alert(1)</script>", "<img src=x>", "<p>  </p><hr><br>", "<!-- x -->"]) {
      await expectCode(box.sendMail({ ...msg, html }), "invalid_input");
      await expectCode(box.createDraft({ ...msg, html }), "invalid_input");
    }
    expect(fake.requests).toHaveLength(before);
    expect(await sendsCounted(stub)).toBe(0);
  });

  it("with a body, HTML that sanitizes to nothing visible is left out: the mail is plain text", async () => {
    const { box } = await signIn(A);
    await box.sendMail({ ...msg, body: "Just text", html: "<script>alert(1)</script>" });
    const create = lastEmailCreate();
    expect(create.bodyValues).toEqual({ body: { value: "Just text" } });
    expect(create.htmlBody).toBeUndefined();
    expect(fake.sent(A)[0]).toMatchObject({ text: "Just text", html: null });
  });

  it("refuses HTML the parser cannot place, nothing sent", async () => {
    const { stub, box } = await signIn(A);
    await expectCode(box.sendMail({ ...msg, body: "b", html: "<p><select>b</p><style>x</style>" }), "invalid_input");
    expect(fake.sent(A)).toEqual([]);
    expect(await sendsCounted(stub)).toBe(0);
  });
});

describe("send_mail with html: dedupe", () => {
  it("the same text with different HTML is two sends; identical ones go out once", async () => {
    const { stub, box } = await signIn(A);
    const first = await box.sendMail({ ...msg, body: "Same", html: "<p>one</p>" });
    expect(await box.sendMail({ ...msg, body: "Same", html: "<p>one</p>" })).toEqual({ ...first, deduplicated: true });
    expect(await box.sendMail({ ...msg, body: "Same", html: "<p>two</p>" })).toMatchObject({ deduplicated: false });
    expect(await box.sendMail({ ...msg, body: "Same" })).toMatchObject({ deduplicated: false });
    expect(fake.sent(A)).toHaveLength(3);
    expect(await sendsCounted(stub)).toBe(3);
  });

  it("HTML that differs only in what the sanitizer removes is the same send", async () => {
    const { box } = await signIn(A);
    await box.sendMail({ ...msg, html: "<p>one</p>" });
    expect(await box.sendMail({ ...msg, html: '<p onclick="x" class="c">one</p><script>y</script>' })).toMatchObject({
      deduplicated: true,
    });
    expect(fake.sent(A)).toHaveLength(1);
  });

  it("the fingerprint covers the HTML; a message without HTML keeps the fingerprint it had", async () => {
    const plain: OutgoingMessage = { ...msg, body: "b" };
    const fp = await sendFingerprint(plain);
    expect(await sendFingerprint({ ...plain, html: "<p>b</p>" })).not.toBe(fp);
    expect(await sendFingerprint({ ...plain, html: "<p>b</p>" })).not.toBe(await sendFingerprint({ ...plain, html: "<p>c</p>" }));
    // The canonical form before HTML existed: [to, cc, bcc, subject, body, in_reply_to].
    const before = JSON.stringify([[OK], [], [], "Hello", "b", null]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(before));
    expect(fp).toBe([...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join(""));
  });
});

describe("create_draft with html", () => {
  it("stores both parts, the text made from the HTML when body is omitted; nothing is sent", async () => {
    const { box } = await signIn(A);
    const draft = await box.createDraft({ ...msg, html: HTML });
    const create = lastEmailCreate();
    expect(create.bodyValues).toEqual({ body: { value: CLEAN_TEXT }, html: { value: CLEAN } });
    expect(create.textBody).toEqual([{ partId: "body", type: "text/plain" }]);
    expect(create.htmlBody).toEqual([{ partId: "html", type: "text/html" }]);
    expect(fake.email(A, draft.draft_id)).toMatchObject({ text: CLEAN_TEXT, html: CLEAN });
    expect(fake.sent(A)).toEqual([]);
  });

  it("keeps a given body as the text part", async () => {
    const { box } = await signIn(A);
    const draft = await box.createDraft({ ...msg, body: "Plain", html: "<p>Rich</p>" });
    expect(fake.email(A, draft.draft_id)).toMatchObject({ text: "Plain", html: "<p>Rich</p>" });
  });

  it("without html stores exactly what it stored before", async () => {
    const { box } = await signIn(A);
    const draft = await box.createDraft({ ...msg, body: "Plain" });
    expect(lastEmailCreate().bodyValues).toEqual({ body: { value: "Plain" } });
    expect(lastEmailCreate().htmlBody).toBeUndefined();
    expect(fake.email(A, draft.draft_id)).toMatchObject({ text: "Plain", html: null });
  });
});
