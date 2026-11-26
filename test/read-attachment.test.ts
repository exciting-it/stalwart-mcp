/**
 * `readAttachment` of the JMAP adapter against the fake Stalwart: the lookup, the download and
 * what the bytes are delivered as. The tool layer and the MCP side are tested in tools.test.ts,
 * mcp-handler.test.ts and isolation.e2e.test.ts.
 */
import { MAIL_LIMITS, MailError, type AttachmentDelivery } from "../src/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSession, UpstreamAuthError, type JmapSession } from "../src/jmap/jmap-client";
import { JmapMailboxAdapter } from "../src/jmap/jmap-mailbox-adapter";
import { STALWART } from "../src/stalwart/endpoints";
import { createFakeStalwart, type AddMessageOptions, type FakeStalwart } from "./fake-stalwart";

const A = "a@test.example";
const B = "b@test.example";
const EVIL = "https://evil.example";

let fake: FakeStalwart;

beforeEach(() => {
  fake = createFakeStalwart();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sessionFor(email: string): Promise<{ accessToken: string; session: JmapSession }> {
  const { accessToken } = fake.tokensFor(email);
  return { accessToken, session: await fetchSession(accessToken) };
}

async function adapterFor(email: string): Promise<JmapMailboxAdapter> {
  const { accessToken, session } = await sessionFor(email);
  return new JmapMailboxAdapter({ accountId: session.accountId, accessToken, session });
}

const downloads = () => fake.requests.filter((r) => new URL(r.url).pathname.startsWith("/jmap/download/"));

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const error = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MailError);
  expect(error).toMatchObject({ code });
}

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
const decode64 = (data: string | null): number[] => [...atob(data ?? "")].map((c) => c.charCodeAt(0));

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest of a png");
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], "rest of a jpeg");
const GIF = bytes("GIF89a", "rest of a gif");
const WEBP = bytes("RIFF", [0x10, 0, 0, 0], "WEBPVP8 ", "rest");
const PDF = bytes("%PDF-1.7\n", [0xe2, 0xe3, 0xcf, 0xd3], "\n1 0 obj");

type Attachment = NonNullable<AddMessageOptions["attachments"]>[number];

/** One message of A with `attachment` as its first attachment (part id "3"), and the adapter. */
async function withAttachment(attachment: Attachment): Promise<{ adapter: JmapMailboxAdapter; messageId: string }> {
  fake.addMailbox(A);
  const { id } = fake.addMessage(A, { subject: "files", attachments: [attachment] });
  return { adapter: await adapterFor(A), messageId: id };
}

async function read(attachment: Attachment, page: { offset?: number; max_chars?: number } = {}): Promise<AttachmentDelivery> {
  const { adapter, messageId } = await withAttachment(attachment);
  return adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: page.offset ?? 0, max_chars: page.max_chars ?? 20_000 });
}

describe("read_thread lists attachment ids", () => {
  it("gives each attachment its part id, and null for one that cannot be used as an id", async () => {
    fake.addMailbox(A);
    const { threadId } = fake.addMessage(A, {
      attachments: [
        { name: "a.txt", type: "text/plain", content: "a" },
        { name: "b.txt", type: "text/plain", content: "b", partId: "2.1" },
        { name: "c.txt", type: "text/plain", content: "c", partId: "../c" },
        { name: "d.txt", type: "text/plain", content: "d", partId: "x".repeat(65) },
      ],
    });
    const { messages } = await (await adapterFor(A)).readThread({ thread_id: threadId });
    expect(messages[0]!.attachments).toEqual([
      { id: "3", name: "a.txt", size: 1, type: "text/plain" },
      { id: "2.1", name: "b.txt", size: 1, type: "text/plain" },
      { id: null, name: "c.txt", size: 1, type: "text/plain" },
      { id: null, name: "d.txt", size: 1, type: "text/plain" },
    ]);
  });
});

describe("readAttachment: text files", () => {
  it("delivers a text file as text, with its name, type and size and no binary data", async () => {
    const r = await read({ name: "notes.txt", type: "text/plain", content: "Invoice total: 42 EUR\nDue in 14 days." });
    expect(r).toEqual({
      message_id: expect.any(String),
      attachment_id: "3",
      name: "notes.txt",
      type: "text/plain",
      size: 37,
      kind: "text",
      text: "Invoice total: 42 EUR\nDue in 14 days.",
      total_chars: 37,
      next_offset: null,
      text_truncated: false,
      data: null,
    });
  });

  it("pages through the text with offset and max_chars to the end", async () => {
    const content = "abcdefghij".repeat(3);
    const { adapter, messageId } = await withAttachment({ name: "t.txt", type: "text/plain", content });
    const page = (offset: number) => adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset, max_chars: 12 });
    const first = await page(0);
    expect(first).toMatchObject({ text: content.slice(0, 12), total_chars: 30, next_offset: 12 });
    const second = await page(first.next_offset!);
    expect(second).toMatchObject({ text: content.slice(12, 24), next_offset: 24 });
    const last = await page(second.next_offset!);
    expect(last).toMatchObject({ text: content.slice(24), next_offset: null });
    expect(await page(500)).toMatchObject({ text: "", total_chars: 30, next_offset: null });
  });

  it("never splits a character outside the basic plane between two pages", async () => {
    const { adapter, messageId } = await withAttachment({ name: "t.txt", type: "text/plain", content: "ab\u{1F600}cd" });
    const first = await adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 3 });
    expect(first).toMatchObject({ text: "ab", next_offset: 2 });
    const second = await adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 2, max_chars: 3 });
    expect(second).toMatchObject({ text: "\u{1F600}c", next_offset: 5 });
  });

  it("considers at most 500,000 characters of a file and reports the rest as cut off", async () => {
    const content = "x".repeat(MAIL_LIMITS.attachmentTextChars + 1000);
    const r = await read({ name: "big.txt", type: "text/plain", content }, { offset: MAIL_LIMITS.attachmentTextChars - 10, max_chars: 50 });
    expect(r).toMatchObject({ kind: "text", text: "x".repeat(10), total_chars: MAIL_LIMITS.attachmentTextChars, next_offset: null, text_truncated: true });
  });

  it("reduces an HTML attachment to its text", async () => {
    const r = await read({ name: "page.html", type: "text/html", content: "<html><head><style>p{}</style></head><body><p>Hello <b>there</b></p><script>steal()</script></body></html>" });
    expect(r).toMatchObject({ kind: "text", type: "text/html", text: "Hello there" });
  });

  it("decodes the declared charset: iso-8859-1, windows-1252, utf-16le and utf-16be", async () => {
    expect(await read({ name: "l.txt", type: "text/plain", charset: "ISO-8859-1", content: bytes([0x47, 0x72, 0xfc, 0xdf, 0x65]) })).toMatchObject({
      kind: "text",
      text: "Gr\u00fc\u00dfe",
    });
    fake = createFakeStalwart();
    vi.stubGlobal("fetch", fake.fetch);
    expect(await read({ name: "w.txt", type: "text/plain", charset: "windows-1252", content: bytes([0x80, 0x20, 0x35]) })).toMatchObject({ text: "\u20ac 5" });
    fake = createFakeStalwart();
    vi.stubGlobal("fetch", fake.fetch);
    expect(await read({ name: "le.txt", type: "text/plain", charset: "utf-16le", content: bytes([0x48, 0, 0x69, 0]) })).toMatchObject({ text: "Hi" });
    fake = createFakeStalwart();
    vi.stubGlobal("fetch", fake.fetch);
    expect(await read({ name: "be.txt", type: "text/plain", charset: "utf-16be", content: bytes([0, 0x48, 0, 0x69]) })).toMatchObject({ text: "Hi" });
  });

  it("reads an unknown or missing charset as utf-8, and JSON, XML and +json / +xml types as text", async () => {
    expect(await read({ name: "u.txt", type: "text/plain", charset: "x-unknown", content: "caf\u00e9" })).toMatchObject({ kind: "text", text: "caf\u00e9" });
    for (const type of ["application/json", "application/xml", "application/ld+json", "image/svg+xml", "text/csv"]) {
      fake = createFakeStalwart();
      vi.stubGlobal("fetch", fake.fetch);
      expect(await read({ name: "f", type, charset: null, content: "<a>1</a>" })).toMatchObject({ kind: "text", type, text: "<a>1</a>" });
    }
  });

  it("delivers bytes that do not decode in the declared charset as a file", async () => {
    const broken = bytes("valid start ", [0xc3, 0x28], " end");
    const r = await read({ name: "broken.txt", type: "text/plain", content: broken });
    expect(r).toMatchObject({ kind: "file", type: "text/plain", text: null, total_chars: null, next_offset: null, text_truncated: false });
    expect(decode64(r.data)).toEqual([...broken]);

    fake = createFakeStalwart();
    vi.stubGlobal("fetch", fake.fetch);
    // US-ASCII is 7 bits: a byte above 0x7F does not decode.
    expect(await read({ name: "a.txt", type: "text/plain", charset: "us-ascii", content: bytes("caf", [0xe9]) })).toMatchObject({ kind: "file" });
  });

  it("removes control and bidi characters from the text", async () => {
    const r = await read({ name: "x.txt", type: "text/plain", content: "pay\u202e to\u200b me\u0007\r\nnow\u2066" });
    expect(r.text).toBe("pay to me\nnow");
  });

  it("cleans the attachment name into one capped line", async () => {
    const r = await read({ name: `in\u202evoice\r\n${"x".repeat(300)}.txt`, type: "text/plain", content: "t" });
    expect(r.name).not.toMatch(/[\r\n\u202e]/);
    expect(r.name!.startsWith("invoice ")).toBe(true);
    expect(r.name!.length).toBeLessThanOrEqual(200);
    expect((await (async () => {
      fake = createFakeStalwart();
      vi.stubGlobal("fetch", fake.fetch);
      return read({ name: null, type: "text/plain", content: "t" });
    })()).name).toBeNull();
  });
});

describe("readAttachment: images", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/gif", GIF],
    ["image/webp", WEBP],
  ])("delivers %s by its signature, with the bytes as base64", async (type, content) => {
    const r = await read({ name: "pic", type: "application/octet-stream", content });
    expect(r).toMatchObject({ kind: "image", type, size: content.length, text: null, total_chars: null, next_offset: null, text_truncated: false });
    expect(decode64(r.data)).toEqual([...content]);
  });

  it("a file declared image/png that is not one is a file, never an image", async () => {
    const r = await read({ name: "fake.png", type: "image/png", content: "<script>not an image</script>" });
    expect(r).toMatchObject({ kind: "file", type: "image/png" });
  });

  it("a PNG declared as text/plain is an image, by its bytes", async () => {
    expect(await read({ name: "x.txt", type: "text/plain", content: PNG })).toMatchObject({ kind: "image", type: "image/png", text: null });
  });
});

describe("readAttachment: other files", () => {
  it("a PDF declared as application/octet-stream is application/pdf, by its bytes", async () => {
    const r = await read({ name: "invoice.bin", type: "application/octet-stream", content: PDF });
    expect(r).toMatchObject({ kind: "file", type: "application/pdf", size: PDF.length });
    expect(decode64(r.data)).toEqual([...PDF]);
  });

  it("keeps a plain declared type, lower-cased; any other becomes application/octet-stream", async () => {
    expect(await read({ name: "a.docx", type: "Application/VND.openxmlformats-officedocument.wordprocessingml.document", content: "PK\u0003\u0004" })).toMatchObject({
      kind: "file",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    for (const odd of ["application/x weird", "application", "application/x\"<script>", "/pdf"]) {
      fake = createFakeStalwart();
      vi.stubGlobal("fetch", fake.fetch);
      expect(await read({ name: "odd", type: odd, content: "zz" })).toMatchObject({ kind: "file", type: "application/octet-stream" });
    }
  });
});

describe("readAttachment: size", () => {
  it("refuses an attachment the server reports as larger than 3 MB, without downloading it", async () => {
    const { adapter, messageId } = await withAttachment({ name: "big.pdf", type: "application/pdf", size: MAIL_LIMITS.attachmentBytes + 1, content: PDF });
    await expectCode(adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 10 }), "too_large");
    expect(downloads()).toHaveLength(0);
  });

  it("delivers exactly 3 MB", async () => {
    const content = new Uint8Array(MAIL_LIMITS.attachmentBytes);
    content.set(PDF);
    const r = await read({ name: "max.pdf", type: "application/pdf", content });
    expect(r).toMatchObject({ kind: "file", size: MAIL_LIMITS.attachmentBytes });
    expect(r.data!.length).toBe(4_000_000);
  });

  it("stops reading a download that sends more than 3 MB, whatever size was reported", async () => {
    const content = new Uint8Array(MAIL_LIMITS.attachmentBytes + 1);
    const { adapter, messageId } = await withAttachment({ name: "liar.pdf", type: "application/pdf", size: 10, content });
    await expectCode(adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 10 }), "too_large");
    expect(downloads()).toHaveLength(1);
  });

  it("stops reading after the cap even when the answer's Content-Length claims less", async () => {
    const { adapter, messageId } = await withAttachment({ name: "liar.pdf", type: "application/pdf", size: 10, content: PDF });
    let pulled = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      if (!new URL(new Request(input, init).url).pathname.startsWith("/jmap/download/")) return res;
      // An endless body: the reader must stop on its own.
      const chunk = new Uint8Array(65_536);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.length;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Length": "10" } });
    });
    await expectCode(adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 10 }), "too_large");
    expect(pulled).toBeLessThan(MAIL_LIMITS.attachmentBytes + 3 * 65_536);
  });
});

describe("readAttachment: whose attachment", () => {
  it("another mailbox's message id is not_found and nothing is downloaded", async () => {
    fake.addMailbox(A);
    fake.addMailbox(B);
    const theirs = fake.addMessage(B, { attachments: [{ name: "secret.txt", type: "text/plain", content: "B only" }] });
    const adapter = await adapterFor(A);
    await expectCode(adapter.readAttachment({ message_id: theirs.id, attachment_id: "3", offset: 0, max_chars: 10 }), "not_found");
    expect(downloads()).toHaveLength(0);
  });

  it("an attachment id of a different message, or none at all, is not_found", async () => {
    fake.addMailbox(A);
    const two = fake.addMessage(A, {
      attachments: [
        { name: "1.txt", type: "text/plain", content: "one" },
        { name: "2.txt", type: "text/plain", content: "two" },
      ],
    });
    const one = fake.addMessage(A, { attachments: [{ name: "only.txt", type: "text/plain", content: "only" }] });
    const plain = fake.addMessage(A, { body: "no attachments" });
    const adapter = await adapterFor(A);
    expect(await adapter.readAttachment({ message_id: two.id, attachment_id: "4", offset: 0, max_chars: 10 })).toMatchObject({ text: "two" });
    await expectCode(adapter.readAttachment({ message_id: one.id, attachment_id: "4", offset: 0, max_chars: 10 }), "not_found");
    // The body parts of a message are not attachments.
    await expectCode(adapter.readAttachment({ message_id: plain.id, attachment_id: "1", offset: 0, max_chars: 10 }), "not_found");
    expect(downloads()).toHaveLength(1);
  });

  it("asks for the message's attachments with their part properties, under the grant's account", async () => {
    const { adapter, messageId } = await withAttachment({ name: "t.txt", type: "text/plain", content: "t" });
    await adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 10 });
    const lookup = fake.requests.find((r) => r.body?.methodCalls)!;
    expect(lookup.body.methodCalls).toEqual([
      [
        "Email/get",
        {
          ids: [messageId],
          properties: ["id", "attachments"],
          bodyProperties: ["partId", "blobId", "size", "name", "type", "charset"],
          accountId: (await sessionFor(A)).session.accountId,
        },
        "a",
      ],
    ]);
  });
});

describe("readAttachment: the download request", () => {
  it("fills the session's template: the grant's account, the blob from the lookup, fixed name and type, with the bearer token", async () => {
    const { adapter, messageId } = await withAttachment({ name: "../../evil name.txt", type: "text/html", content: "t" });
    const { accountId } = (await sessionFor(A)).session;
    const blobId = fake.email(A, messageId)!.attachments[0]!.blobId;
    await adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 10 });
    expect(downloads()).toEqual([
      {
        url: `${STALWART.origin}/jmap/download/${accountId}/${blobId}/attachment?accept=application%2Foctet-stream`,
        method: "GET",
        authorization: `Bearer ${fake.tokensFor(A).accessToken}`,
        body: null,
      },
    ]);
  });

  it("never follows a redirect from the download", async () => {
    const { adapter, messageId } = await withAttachment({ name: "t.txt", type: "text/plain", content: "t" });
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      if (!new URL(new Request(input, init).url).pathname.startsWith("/jmap/download/")) return res;
      inits.push(init);
      return new Response(null, { status: 302, headers: { Location: `${EVIL}/steal` } });
    });
    await expectCode(adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 10 }), "upstream_rejected");
    expect(inits).toHaveLength(1);
    expect(inits[0]?.redirect).toBe("manual");
    expect(fake.requests.every((r) => r.url.startsWith(`${STALWART.origin}/`))).toBe(true);
  });

  it("a session whose downloadUrl is on another origin or unusable has none: mailbox_unsupported, no request", async () => {
    fake.addMailbox(A);
    const { id } = fake.addMessage(A, { attachments: [{ name: "t.txt", type: "text/plain", content: "t" }] });
    const { accessToken } = fake.tokensFor(A);
    for (const downloadUrl of [`${EVIL}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`, `${STALWART.origin}/jmap/download/{accountId}/fixed`, 42, undefined]) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await fake.fetch(input, init);
        if (new Request(input, init).url !== STALWART.session) return res;
        const body = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...body, downloadUrl });
      });
      const session = await fetchSession(accessToken);
      expect(session.downloadUrl).toBeNull();
      const before = fake.requests.length;
      const adapter = new JmapMailboxAdapter({ accountId: session.accountId, accessToken, session });
      await expectCode(adapter.readAttachment({ message_id: id, attachment_id: "3", offset: 0, max_chars: 10 }), "mailbox_unsupported");
      expect(fake.requests).toHaveLength(before);
    }

    // A stored or hand-made session with a foreign template is refused the same way.
    const own = await fetchSession(accessToken);
    const forged: JmapSession = { ...own, downloadUrl: `${EVIL}/{accountId}/{blobId}` };
    const before = fake.requests.length;
    const adapter = new JmapMailboxAdapter({ accountId: own.accountId, accessToken, session: forged });
    await expectCode(adapter.readAttachment({ message_id: id, attachment_id: "3", offset: 0, max_chars: 10 }), "mailbox_unsupported");
    expect(fake.requests).toHaveLength(before);
  });

  it("maps 401, 5xx and 404 from the download like the other calls, without upstream text", async () => {
    const { adapter, messageId } = await withAttachment({ name: "t.txt", type: "text/plain", content: "t" });
    const answer = (status: number) =>
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await fake.fetch(input, init);
        if (!new URL(new Request(input, init).url).pathname.startsWith("/jmap/download/")) return res;
        return new Response("fake-stalwart upstream detail", { status });
      });
    const call = () => adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 10 });
    answer(401);
    await expect(call()).rejects.toBeInstanceOf(UpstreamAuthError);
    answer(503);
    await expectCode(call(), "upstream_unavailable");
    answer(404);
    await expectCode(call(), "upstream_rejected");
    for (const status of [503, 404]) {
      answer(status);
      const error = await call().catch((e: unknown) => e);
      expect(String((error as Error).message)).not.toContain("upstream detail");
    }
  });

  it("a blob id in the server's answer that is not an id is upstream_rejected, never sent", async () => {
    const { adapter, messageId } = await withAttachment({ name: "t.txt", type: "text/plain", content: "t" });
    fake.email(A, messageId)!.attachments[0]!.blobId = "../../admin";
    await expectCode(adapter.readAttachment({ message_id: messageId, attachment_id: "3", offset: 0, max_chars: 10 }), "upstream_rejected");
    expect(downloads()).toHaveLength(0);
  });
});
