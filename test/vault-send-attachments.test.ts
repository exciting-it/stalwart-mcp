import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  EXECUTABLE_EXTENSIONS,
  MAIL_LIMITS,
  MailError,
  type MailErrorCode,
  type OutgoingMessage,
  SendMailInput,
  writtenAttachmentBytes,
} from "../src/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import { fetchSession, type JmapSession } from "../src/jmap/jmap-client";
import { JmapMailboxAdapter } from "../src/jmap/jmap-mailbox-adapter";
import { sendFingerprint } from "../src/vault/limits";
import { type MailboxVault, vaultFor } from "../src/vault/mailbox-vault";
import { VaultMailbox } from "../src/vault/vault-mailbox";
import { STALWART } from "../src/stalwart/endpoints";
import { createFakeStalwart, type FakeStalwart, type RecordedRequest } from "./fake-stalwart";

/**
 * Attachments on `send_mail` and `create_draft`: a file of a message of this mailbox by its ids,
 * a text file, or a small file as base64. Runs through `VaultMailbox` and the vault, as the tools
 * do; the session's upload template is tested on the adapter.
 */

const ORIGIN = "https://mail-mcp.test.example";
const EVIL = "https://evil.example";
const A = "a@test.example";
const B = "b@test.example";
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

const msg: OutgoingMessage = { to: [OK], cc: [], bcc: [], subject: "Files", body: "See attached." };

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));
const base64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const bigBase64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest of a png");
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], "rest of a jpeg");
const PDF = bytes("%PDF-1.7\n", "1 0 obj");

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
const uploads = () => fake.requests.filter((r) => new URL(r.url).pathname.startsWith("/jmap/upload/"));
const emailSets = () =>
  jmapRequests()
    .flatMap((r: RecordedRequest) => r.body.methodCalls as [string, Record<string, unknown>][])
    .filter(([name, args]) => name === "Email/set" && args.create !== undefined);

/** The `Email/set` create of the latest request that has one. */
function lastEmailCreate(): Record<string, unknown> {
  const create = emailSets().at(-1)![1].create as Record<string, Record<string, unknown>>;
  return create.draft!;
}

function sendsCounted(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (_v: MailboxVault, state) => {
    const row = state.storage.sql.exec("SELECT count FROM usage_counter WHERE name = 'send'").toArray()[0];
    return row ? Number(row.count) : 0;
  });
}

/** Answers every upload with `status`, the rest as the fake does. */
function failUploads(status: number): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fake.fetch(input, init);
    if (!new URL(new Request(input, init).url).pathname.startsWith("/jmap/upload/")) return res;
    return new Response("fake-stalwart upstream detail", { status });
  });
}

/** A message of A with `attachments`; its id. */
function messageOfA(attachments: NonNullable<Parameters<FakeStalwart["addMessage"]>[1]>["attachments"]): string {
  return fake.addMessage(A, { subject: "with files", attachments }).id;
}

describe("send_mail with attachments: each way", () => {
  it("a text file is uploaded as UTF-8 to the session's upload URL and attached", async () => {
    const { accountId, box } = await signIn(A);
    const text = "Total: 42 \u20ac\nDue in 14 days.";
    const sent = await box.sendMail({ ...msg, attachments: [{ filename: "notes.txt", text }] });
    expect(sent).toMatchObject({ deduplicated: false, attachments: 1 });

    expect(uploads()).toHaveLength(1);
    const upload = uploads()[0]!;
    expect(upload.method).toBe("POST");
    expect(upload.url).toBe(`${STALWART.origin}/jmap/upload/${accountId}/`);
    expect(upload.authorization).toBe(`Bearer ${fake.tokensFor(A).accessToken}`);
    expect(upload.contentType).toBe("text/plain; charset=utf-8");
    expect([...upload.bytes!]).toEqual([...new TextEncoder().encode(text)]);

    const blobId = fake.uploadedBlobs(A)[0]!.blobId;
    expect(lastEmailCreate().attachments).toEqual([
      { blobId, type: "text/plain", name: "notes.txt", disposition: "attachment", charset: "utf-8" },
    ]);
    expect(fake.sent(A)).toHaveLength(1);
    expect(fake.sent(A)[0]!.attachments).toEqual([
      { name: "notes.txt", type: "text/plain", size: new TextEncoder().encode(text).length, content: new TextEncoder().encode(text) },
    ]);

    // Read back through read_thread and read_attachment.
    const thread = await box.readThread({ thread_id: fake.email(A, sent.message_id)!.threadId });
    const size = new TextEncoder().encode(text).length;
    expect(thread.messages[0]!.attachments).toEqual([{ id: "3", name: "notes.txt", size, type: "text/plain" }]);
    const read = await box.readAttachment({ message_id: sent.message_id, attachment_id: "3", offset: 0, max_chars: 100 });
    expect(read).toMatchObject({ kind: "text", text, name: "notes.txt" });
  });

  it("each text type is accepted; text/html is fine for a file named .txt", async () => {
    const { box } = await signIn(A);
    const types = ["text/plain", "text/csv", "text/markdown", "text/calendar", "text/html", "application/json"] as const;
    for (const [i, content_type] of types.entries()) {
      await box.createDraft({ ...msg, attachments: [{ filename: `f${i}.txt`, text: `t${i}`, content_type }] });
      expect(uploads().at(-1)!.contentType).toBe(`${content_type}; charset=utf-8`);
      expect((lastEmailCreate().attachments as { type: string }[])[0]!.type).toBe(content_type);
    }
  });

  it("a base64 file is decoded and uploaded with its type, and read back as that file", async () => {
    const { box } = await signIn(A);
    const sent = await box.sendMail({ ...msg, attachments: [{ filename: "chart.png", base64: base64(PNG), content_type: "image/png" }] });
    expect(sent.attachments).toBe(1);
    const upload = uploads()[0]!;
    expect(upload.contentType).toBe("image/png");
    expect([...upload.bytes!]).toEqual([...PNG]);
    expect(lastEmailCreate().attachments).toEqual([
      { blobId: fake.uploadedBlobs(A)[0]!.blobId, type: "image/png", name: "chart.png", disposition: "attachment" },
    ]);
    const read = await box.readAttachment({ message_id: sent.message_id, attachment_id: "3", offset: 0, max_chars: 100 });
    expect(read).toMatchObject({ kind: "image", type: "image/png", name: "chart.png", data: base64(PNG) });
  });

  it("base64 without padding is accepted", async () => {
    const { box } = await signIn(A);
    const unpadded = base64(PDF).replace(/=+$/, "");
    expect(unpadded).not.toBe(base64(PDF));
    await box.createDraft({ ...msg, attachments: [{ filename: "a.pdf", base64: unpadded, content_type: "application/pdf" }] });
    expect([...uploads()[0]!.bytes!]).toEqual([...PDF]);
  });

  it("a file of a message of this mailbox reuses its blob: nothing is downloaded or uploaded", async () => {
    const { box } = await signIn(A);
    const source = messageOfA([
      { name: "Invoice\r\n2026.pdf", type: "Application/PDF", content: PDF },
      { name: null, type: "not a media type", content: "x" },
      { name: "data.txt", type: "text/plain", content: "caf\u00e9", charset: "iso-8859-1" },
    ]);
    const stored = fake.email(A, source)!.attachments;
    const sent = await box.sendMail({
      ...msg,
      attachments: [
        { message_id: source, attachment_id: "3" },
        { message_id: source, attachment_id: "4" },
        { message_id: source, attachment_id: "5" },
      ],
    });
    expect(sent.attachments).toBe(3);
    expect(uploads()).toHaveLength(0);
    expect(fake.requests.some((r) => new URL(r.url).pathname.startsWith("/jmap/download/"))).toBe(false);
    // The stored name (one line), the stored type when plain, else octet-stream; no name: "attachment".
    expect(lastEmailCreate().attachments).toEqual([
      { blobId: stored[0]!.blobId, type: "application/pdf", name: "Invoice 2026.pdf", disposition: "attachment" },
      { blobId: stored[1]!.blobId, type: "application/octet-stream", name: "attachment", disposition: "attachment" },
      { blobId: stored[2]!.blobId, type: "text/plain", name: "data.txt", disposition: "attachment", charset: "iso-8859-1" },
    ]);
    // The lookup is one Email/get of the source in the request with the folders and the identity.
    const lookup = jmapRequests().find((r) => (r.body.methodCalls as [string][]).some(([n]) => n === "Identity/get"))!;
    expect(lookup.body.methodCalls).toContainEqual([
      "Email/get",
      { ids: [source], properties: ["id", "attachments"], bodyProperties: ["partId", "blobId", "size", "name", "type", "charset"], accountId: expect.any(String) },
      "a",
    ]);
    expect(fake.sent(A)[0]!.attachments.map((a) => a.name)).toEqual(["Invoice 2026.pdf", "attachment", "data.txt"]);

    const read = await box.readAttachment({ message_id: sent.message_id, attachment_id: "3", offset: 0, max_chars: 100 });
    expect(read).toMatchObject({ kind: "file", type: "application/pdf", name: "Invoice 2026.pdf", data: base64(PDF) });
  });

  it("all three together, in the order given; create_draft stores them and sends nothing", async () => {
    const { box } = await signIn(A);
    const source = messageOfA([{ name: "report.pdf", type: "application/pdf", content: PDF }]);
    const attachments = [
      { filename: "summary.md", text: "# Summary", content_type: "text/markdown" as const },
      { message_id: source, attachment_id: "3" },
      { filename: "photo.jpg", base64: base64(JPEG), content_type: "image/jpeg" as const },
    ];
    const draft = await box.createDraft({ ...msg, attachments });
    expect(draft).toMatchObject({ attachments: 3 });
    expect(uploads().map((u) => u.contentType)).toEqual(["text/markdown; charset=utf-8", "image/jpeg"]);
    expect((lastEmailCreate().attachments as { name: string }[]).map((a) => a.name)).toEqual(["summary.md", "report.pdf", "photo.jpg"]);
    expect(fake.email(A, draft.draft_id)!.attachments.map((a) => [a.name, a.type, a.size])).toEqual([
      ["summary.md", "text/markdown", 9],
      ["report.pdf", "application/pdf", PDF.length],
      ["photo.jpg", "image/jpeg", JPEG.length],
    ]);
    expect(fake.sent(A)).toEqual([]);

    const sent = await box.sendMail({ ...msg, attachments });
    expect(sent).toMatchObject({ attachments: 3, deduplicated: false });
    expect(fake.sent(A)[0]!.attachments.map((a) => a.name)).toEqual(["summary.md", "report.pdf", "photo.jpg"]);
  });
});

describe("send_mail with attachments: another mailbox's files", () => {
  it("another mailbox's message is not found: nothing uploaded, created or sent, nothing counted", async () => {
    const { stub, box } = await signIn(A);
    fake.addMailbox(B);
    const theirs = fake.addMessage(B, { attachments: [{ name: "secret.pdf", type: "application/pdf", content: PDF }] }).id;
    const before = emailSets().length;
    for (const call of [
      () => box.sendMail({ ...msg, attachments: [{ filename: "a.txt", text: "a" }, { message_id: theirs, attachment_id: "3" }] }),
      () => box.createDraft({ ...msg, attachments: [{ message_id: theirs, attachment_id: "3" }] }),
    ]) {
      await expectCode(call(), "not_found");
    }
    expect(uploads()).toHaveLength(0);
    expect(emailSets()).toHaveLength(before);
    expect(fake.sent(A)).toEqual([]);
    expect(await sendsCounted(stub)).toBe(0);
    // The identical call may be made again: no dedupe row was left.
    await expectCode(box.sendMail({ ...msg, attachments: [{ message_id: theirs, attachment_id: "3" }] }), "not_found");
  });

  it("an attachment id that belongs to another message of this mailbox is not found", async () => {
    const { box } = await signIn(A);
    const plain = fake.addMessage(A, { subject: "no files" }).id;
    const withFile = messageOfA([{ name: "a.pdf", type: "application/pdf", content: PDF }]);
    await expectCode(box.sendMail({ ...msg, attachments: [{ message_id: plain, attachment_id: "3" }] }), "not_found");
    await expectCode(box.sendMail({ ...msg, attachments: [{ message_id: withFile, attachment_id: "4" }] }), "not_found");
    expect(fake.sent(A)).toEqual([]);
  });

  it("a blob id in the server's answer that is not an id is upstream_rejected, never sent", async () => {
    const { box } = await signIn(A);
    const source = messageOfA([{ name: "a.pdf", type: "application/pdf", content: PDF }]);
    fake.email(A, source)!.attachments[0]!.blobId = "../../admin";
    await expectCode(box.sendMail({ ...msg, attachments: [{ message_id: source, attachment_id: "3" }] }), "upstream_rejected");
    expect(fake.sent(A)).toEqual([]);
  });
});

describe("attachments: file names", () => {
  const refused = [
    "",
    "x".repeat(201),
    "a\nb.txt",
    "a\rb.txt",
    "a\tb.txt",
    "a\u0000b.txt",
    "a\u2028b.txt",
    "a\u202eb.txt",
    "a\u2066b.txt",
    "dir/a.txt",
    "dir\\a.txt",
    ".",
    "..",
    " a.txt",
    "a.txt ",
    ".hidden",
    "a.txt.",
  ];

  it("refuses each broken name before the mailbox is touched", async () => {
    const { stub, box } = await signIn(A);
    const before = fake.requests.length;
    for (const filename of refused) {
      await expectCode(box.sendMail({ ...msg, attachments: [{ filename, text: "t" }] }), "invalid_input");
      await expectCode(
        box.createDraft({ ...msg, attachments: [{ filename, base64: base64(PNG), content_type: "image/png" }] }),
        "invalid_input",
      );
    }
    expect(fake.requests).toHaveLength(before);
    expect(await sendsCounted(stub)).toBe(0);
    expect(await box.createDraft({ ...msg, attachments: [{ filename: "x".repeat(200), text: "t" }] })).toMatchObject({ attachments: 1 });
  });

  it("refuses every file type that runs when opened, in any case and before a trailing dot or space", async () => {
    expect(EXECUTABLE_EXTENSIONS).toEqual([
      ".exe", ".com", ".bat", ".cmd", ".scr", ".pif", ".msi", ".msp", ".js", ".jse", ".vbs", ".vbe", ".wsf", ".wsh", ".ps1",
      ".jar", ".lnk", ".hta", ".cpl", ".dll", ".reg", ".iso", ".img", ".vhd", ".vhdx", ".apk", ".app", ".dmg", ".pkg", ".sh",
      ".command", ".scpt", ".html", ".htm", ".svg", ".xhtml", ".url", ".scf", ".chm", ".hlp", ".wsc", ".sct", ".msc",
      ".gadget", ".inf", ".application", ".appref-ms", ".xll", ".xlam", ".docm", ".dotm", ".xlsm", ".xltm", ".pptm",
      ".potm", ".ppsm", ".mht", ".mhtml", ".svgz", ".ps1xml", ".psm1", ".psd1", ".psc1", ".vb", ".ws", ".cab",
      ".diagcab", ".ade", ".adp", ".mde", ".accde", ".py", ".pyc", ".pl", ".rb", ".php",
      ".appx", ".appxbundle", ".msix", ".msixbundle", ".shtml", ".xht", ".pyw", ".mjs", ".cjs", ".bash", ".zsh",
      ".desktop", ".terminal", ".webloc", ".inetloc", ".workflow", ".action",
    ]);
    // An XML file stays allowed on purpose: electronic invoices (XRechnung) are XML attachments.
    expect(SendMailInput.safeParse({ ...msg, attachments: [{ filename: "rechnung.xml", text: "<x/>" }] }).success).toBe(true);
    const { box } = await signIn(A);
    const before = fake.requests.length;
    for (const ext of EXECUTABLE_EXTENSIONS) {
      const mixed = [...ext].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join("");
      for (const filename of [`run${ext}`, `RUN${ext.toUpperCase()}`, `run${mixed}`, `report.pdf${ext}`]) {
        expect(SendMailInput.safeParse({ ...msg, attachments: [{ filename, text: "t" }] }).success, filename).toBe(false);
        await expectCode(box.createDraft({ ...msg, attachments: [{ filename, text: "t" }] }), "invalid_input");
      }
    }
    // Disguises: a trailing dot or space after the ending (refused as a name anyway), an invisible
    // character between, a full-width ending.
    for (const filename of ["run.exe.", "run.exe ", "run.exe. .", "run.ex\u200be", "run\uff0eexe", "run.\uff45xe"]) {
      expect(SendMailInput.safeParse({ ...msg, attachments: [{ filename, text: "t" }] }).success, filename).toBe(false);
    }
    expect(fake.requests).toHaveLength(before);
    // Names that only contain an ending elsewhere are fine.
    for (const filename of ["exe.txt", "notes.js.txt", "page.html.md", "my.shell.csv"]) {
      expect(SendMailInput.safeParse({ ...msg, attachments: [{ filename, text: "t" }] }).success, filename).toBe(true);
    }
  });

  it("refuses a stored file whose name has such an ending: nothing uploaded or sent", async () => {
    const { stub, box } = await signIn(A);
    const source = messageOfA([
      { name: "setup.EXE", type: "application/octet-stream", content: "MZ" },
      { name: "invoice.pdf.Js.", type: "application/pdf", content: PDF },
      { name: "page.hTmL ", type: "text/html", content: "<p>x</p>" },
      { name: "drop.sv\u200bg", type: "image/svg+xml", content: "<svg/>" },
      { name: "fine.pdf", type: "application/pdf", content: PDF },
    ]);
    for (const attachment_id of ["3", "4", "5", "6"]) {
      await expectCode(
        box.sendMail({ ...msg, attachments: [{ filename: "a.txt", text: "a" }, { message_id: source, attachment_id }] }),
        "invalid_input",
      );
    }
    expect(uploads()).toHaveLength(0);
    expect(fake.sent(A)).toEqual([]);
    expect(await sendsCounted(stub)).toBe(0);
    expect(await box.sendMail({ ...msg, attachments: [{ message_id: source, attachment_id: "7" }] })).toMatchObject({ attachments: 1 });
  });
});

describe("attachments: types, sizes and counts", () => {
  it("refuses content types outside the lists", async () => {
    const { box } = await signIn(A);
    const before = fake.requests.length;
    const bad = [
      { filename: "a.txt", text: "t", content_type: "application/pdf" },
      { filename: "a.txt", text: "t", content_type: "image/png" },
      { filename: "a.txt", text: "t", content_type: "TEXT/PLAIN" },
      { filename: "a.txt", text: "t", content_type: "text/plain; charset=utf-8" },
      { filename: "a.zip", base64: base64(PNG), content_type: "application/zip" },
      { filename: "a.svg", base64: base64(PNG), content_type: "image/svg+xml" },
      { filename: "a.bin", base64: base64(PNG), content_type: "application/octet-stream" },
      { filename: "a.bin", base64: base64(PNG) },
      { filename: "a.txt", text: "t", base64: base64(PNG), content_type: "text/plain" },
      { message_id: "em1", attachment_id: "3", filename: "a.txt" },
      { message_id: "em1" },
    ];
    for (const attachment of bad) {
      expect(SendMailInput.safeParse({ ...msg, attachments: [attachment] }).success, JSON.stringify(attachment)).toBe(false);
      await expectCode(box.createDraft({ ...msg, attachments: [attachment] } as OutgoingMessage), "invalid_input");
    }
    expect(fake.requests).toHaveLength(before);
  });

  it("the PDF and image types need their signature: a PNG declared as a PDF is refused, nothing uploaded", async () => {
    const { stub, box } = await signIn(A);
    for (const [content, content_type] of [
      [PNG, "application/pdf"],
      [JPEG, "image/png"],
      [PDF, "image/jpeg"],
      [bytes("hello"), "image/gif"],
      [bytes("RIFF0000WEBX"), "image/webp"],
    ] as const) {
      await expectCode(box.sendMail({ ...msg, attachments: [{ filename: "f.bin.txt", base64: base64(content), content_type }] }), "invalid_input");
    }
    expect(uploads()).toHaveLength(0);
    expect(await sendsCounted(stub)).toBe(0);
    // A text type as base64 carries any bytes.
    await box.createDraft({ ...msg, attachments: [{ filename: "raw.csv", base64: base64(PNG), content_type: "text/csv" }] });
    expect(uploads()).toHaveLength(1);
  });

  it("refuses text over 200,000 characters and base64 over 1,000,000 bytes", async () => {
    const { box } = await signIn(A);
    const text = "x".repeat(MAIL_LIMITS.attachmentTextInputChars);
    await expectCode(box.createDraft({ ...msg, attachments: [{ filename: "a.txt", text: `${text}x` }] }), "invalid_input");
    const file = new Uint8Array(MAIL_LIMITS.attachmentUploadBytes + 1);
    file.set(PDF);
    await expectCode(
      box.createDraft({ ...msg, attachments: [{ filename: "a.pdf", base64: bigBase64(file), content_type: "application/pdf" }] }),
      "invalid_input",
    );
    expect(uploads()).toHaveLength(0);
    await box.createDraft({ ...msg, attachments: [{ filename: "a.txt", text }] });
    await box.createDraft({
      ...msg,
      attachments: [{ filename: "a.pdf", base64: bigBase64(file.subarray(0, MAIL_LIMITS.attachmentUploadBytes)), content_type: "application/pdf" }],
    });
    expect(uploads().map((u) => u.bytes!.length)).toEqual([MAIL_LIMITS.attachmentTextInputChars, MAIL_LIMITS.attachmentUploadBytes]);
  });

  it("refuses invalid base64", async () => {
    const { box } = await signIn(A);
    for (const b64 of ["a", "abcde", "ab=c", "ab===", "a===", "ab c", "ab\ncd", "ab-_", "ab$c", "=abc", "abc=d"]) {
      expect(SendMailInput.safeParse({ ...msg, attachments: [{ filename: "a.csv", base64: b64, content_type: "text/csv" }] }).success, b64).toBe(false);
      await expectCode(box.createDraft({ ...msg, attachments: [{ filename: "a.csv", base64: b64, content_type: "text/csv" }] }), "invalid_input");
    }
    expect(uploads()).toHaveLength(0);
  });

  it("refuses more than five attachments", async () => {
    const { box } = await signIn(A);
    const file = (i: number) => ({ filename: `f${i}.txt`, text: `t${i}` });
    const six = Array.from({ length: MAIL_LIMITS.attachmentsPerMessage + 1 }, (_, i) => file(i));
    await expectCode(box.sendMail({ ...msg, attachments: six }), "invalid_input");
    expect(uploads()).toHaveLength(0);
    expect(await box.sendMail({ ...msg, attachments: six.slice(1) })).toMatchObject({ attachments: 5 });
  });

  it("refuses a total over 10,000,000 bytes, the stored files by the server's size: too_large, nothing uploaded or sent", async () => {
    const { stub, box } = await signIn(A);
    const source = messageOfA([
      { name: "big.pdf", type: "application/pdf", size: 9_500_000, content: PDF },
      { name: "huge.pdf", type: "application/pdf", size: 5_000_001, content: PDF },
    ]);
    const file = new Uint8Array(500_001);
    file.set(PNG);
    const upload = { filename: "pic.png", base64: bigBase64(file), content_type: "image/png" as const };
    await expectCode(box.sendMail({ ...msg, attachments: [{ message_id: source, attachment_id: "3" }, upload] }), "too_large");
    await expectCode(
      box.createDraft({ ...msg, attachments: [{ message_id: source, attachment_id: "4" }, { message_id: source, attachment_id: "4" }] }),
      "too_large",
    );
    expect(uploads()).toHaveLength(0);
    expect(fake.sent(A)).toEqual([]);
    expect(await sendsCounted(stub)).toBe(0);
    // Exactly at the limit is fine.
    const fits = { ...upload, base64: bigBase64(file.subarray(0, 500_000)) };
    expect(await box.sendMail({ ...msg, attachments: [{ message_id: source, attachment_id: "3" }, fits] })).toMatchObject({ attachments: 2 });
  });
});

describe("attachments: a failed upload", () => {
  it("is the mapped error; nothing is sent or counted, and the identical call may be made again", async () => {
    const { stub, box } = await signIn(A);
    const call = () => box.sendMail({ ...msg, attachments: [{ filename: "a.txt", text: "a" }] });
    failUploads(503);
    await expectCode(call(), "upstream_unavailable");
    failUploads(413);
    await expectCode(call(), "upstream_rejected");
    expect(emailSets()).toHaveLength(0);
    expect(fake.sent(A)).toEqual([]);
    expect(await sendsCounted(stub)).toBe(0);

    vi.stubGlobal("fetch", fake.fetch);
    expect(await call()).toMatchObject({ deduplicated: false, attachments: 1 });
    expect(fake.sent(A)).toHaveLength(1);
    expect(await sendsCounted(stub)).toBe(1);
  });

  it("a network failure of the upload is upstream_unavailable, never send_unconfirmed", async () => {
    const { stub, box } = await signIn(A);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(new Request(input, init).url).pathname.startsWith("/jmap/upload/")) throw new TypeError("network");
      return fake.fetch(input, init);
    });
    await expectCode(box.sendMail({ ...msg, attachments: [{ filename: "a.txt", text: "a" }] }), "upstream_unavailable");
    expect(await sendsCounted(stub)).toBe(0);
  });
});

describe("attachments: review round 1", () => {
  it("files written into one call total at most 2,000,000 bytes: more is too_large before anything is uploaded", async () => {
    expect(MAIL_LIMITS.attachmentUploadTotalBytes).toBe(2_000_000);
    const { stub, box } = await signIn(A);
    const file = (n: number) => {
      const b = new Uint8Array(n);
      b.set(PDF);
      return bigBase64(b);
    };
    const pdf = (name: string, n: number) => ({ filename: name, base64: file(n), content_type: "application/pdf" as const });
    // Two full base64 files are the cap; one byte of text more is over it.
    const over = [pdf("a.pdf", 1_000_000), pdf("b.pdf", 1_000_000), { filename: "c.txt", text: "x" }];
    expect(writtenAttachmentBytes(over)).toBe(2_000_001);
    // Text counts as UTF-8: 200,000 characters of three bytes each.
    const wide = Array.from({ length: 4 }, (_, i) => ({ filename: `w${i}.txt`, text: "\u20ac".repeat(200_000) }));
    expect(writtenAttachmentBytes(wide)).toBe(2_400_000);
    const before = fake.requests.length;
    await expectCode(box.sendMail({ ...msg, attachments: over }), "too_large");
    await expectCode(box.createDraft({ ...msg, attachments: wide }), "too_large");
    expect(fake.requests).toHaveLength(before);
    expect(await sendsCounted(stub)).toBe(0);
    // The schema itself stays shape-only: the cap is its own check with its own code.
    expect(SendMailInput.safeParse({ ...msg, attachments: over }).success).toBe(true);
    // Files of the mailbox do not count toward it.
    const source = messageOfA([{ name: "big.pdf", type: "application/pdf", size: 5_000_000, content: PDF }]);
    const atCap = [pdf("a.pdf", 1_000_000), pdf("b.pdf", 1_000_000), { message_id: source, attachment_id: "3" }];
    expect(await box.sendMail({ ...msg, attachments: atCap })).toMatchObject({ attachments: 3 });
  });

  it("file names may not carry \" : * ? < > or |", async () => {
    const { box } = await signIn(A);
    const before = fake.requests.length;
    for (const filename of ['x.exe"', "x.exe::$DATA", "x.exe:.txt", "x.exe*", "x.exe?", "x.exe<", "x.exe>", "x.exe|", 'a"b.txt', "a:b.txt", "a*b.txt", "a?b.txt", "a<b.txt", "a>b.txt", "a|b.txt"]) {
      expect(SendMailInput.safeParse({ ...msg, attachments: [{ filename, text: "t" }] }).success, filename).toBe(false);
      await expectCode(box.createDraft({ ...msg, attachments: [{ filename, base64: base64(PNG), content_type: "image/png" }] }), "invalid_input");
    }
    expect(fake.requests).toHaveLength(before);
  });

  it("the added endings are refused too, macro-enabled Office files included", async () => {
    const added = [
      ".url", ".scf", ".chm", ".hlp", ".wsc", ".sct", ".msc", ".gadget", ".inf", ".application", ".appref-ms", ".xll",
      ".xlam", ".docm", ".dotm", ".xlsm", ".xltm", ".pptm", ".potm", ".ppsm", ".mht", ".mhtml", ".svgz", ".ps1xml",
      ".psm1", ".psd1", ".psc1", ".vb", ".ws", ".cab", ".diagcab", ".ade", ".adp", ".mde", ".accde", ".py", ".pyc",
      ".pl", ".rb", ".php",
    ];
    for (const ext of added) {
      expect(EXECUTABLE_EXTENSIONS as readonly string[]).toContain(ext);
      for (const filename of [`f${ext}`, `F${ext.toUpperCase()}`]) {
        expect(SendMailInput.safeParse({ ...msg, attachments: [{ filename, text: "t" }] }).success, filename).toBe(false);
      }
    }
    for (const filename of ["report.docx", "sheet.xlsx", "deck.pptx", "notes.md"]) {
      expect(SendMailInput.safeParse({ ...msg, attachments: [{ filename, text: "t" }] }).success, filename).toBe(true);
    }
  });

  it("a stored name counts by its last path segment and follows the rules of a written name", async () => {
    const { box } = await signIn(A);
    const source = messageOfA([
      { name: "../../evil.txt", type: "text/plain", content: "a" },
      { name: "dir\\sub\\report.pdf", type: "application/pdf", content: PDF },
      { name: "folder/", type: "text/plain", content: "c" },
      { name: " . report.csv. ", type: "text/csv", content: "d" },
      { name: "x.exe::$DATA", type: "application/octet-stream", content: "e" },
      { name: 'x.exe"', type: "application/octet-stream", content: "f" },
      { name: "safe/../run.EXE", type: "application/octet-stream", content: "g" },
      { name: "Re: invoice?.pdf", type: "application/pdf", content: PDF },
      { name: "line\u2028break.txt", type: "text/plain", content: "h" },
    ]);
    const names = async (ids: string[]) => {
      await box.createDraft({ ...msg, attachments: ids.map((attachment_id) => ({ message_id: source, attachment_id })) });
      return (lastEmailCreate().attachments as { name: string }[]).map((a) => a.name);
    };
    expect(await names(["3", "4", "5", "6"])).toEqual(["evil.txt", "report.pdf", "attachment", "report.csv"]);
    // A received file keeps its name as far as it can: a character a written name may not have
    // becomes `_`. A program ending hidden behind such a character is still refused.
    expect(await names(["10"])).toEqual(["Re_ invoice_.pdf"]);
    for (const attachment_id of ["7", "8", "9", "11"]) {
      await expectCode(box.createDraft({ ...msg, attachments: [{ message_id: source, attachment_id }] }), "invalid_input");
    }
    expect(uploads()).toHaveLength(0);
  });

  it("the stored type goes out when it is a plain media type, else as application/octet-stream", async () => {
    const { box } = await signIn(A);
    const source = messageOfA([
      { name: "a.pdf", type: "application/pdf", content: PDF },
      { name: "b.txt", type: "Text/Plain", content: "b" },
      { name: "c.bin", type: "application/pdf; name=c.pdf", content: PDF },
      { name: "d.bin", type: "", content: "d" },
      { name: "e.bin", type: "image/png\nX-Evil: 1", content: "e" },
      { name: "f.page", type: "text/html", content: "<p>f</p>" },
    ]);
    const types = async (ids: string[]) => {
      await box.createDraft({ ...msg, attachments: ids.map((attachment_id) => ({ message_id: source, attachment_id })) });
      return (lastEmailCreate().attachments as { type: string }[]).map((a) => a.type);
    };
    expect(await types(["3", "4", "5"])).toEqual(["application/pdf", "text/plain", "application/octet-stream"]);
    expect(await types(["6", "7", "8"])).toEqual(["application/octet-stream", "application/octet-stream", "text/html"]);
  });

  it("a stored size that is negative or not a whole number is upstream_rejected and never lowers the total", async () => {
    const { stub, box } = await signIn(A);
    const source = messageOfA([
      { name: "big.pdf", type: "application/pdf", size: 9_999_999, content: PDF },
      { name: "neg.pdf", type: "application/pdf", content: PDF },
      { name: "half.pdf", type: "application/pdf", content: PDF },
    ]);
    fake.email(A, source)!.attachments[1]!.size = -5_000_000;
    fake.email(A, source)!.attachments[2]!.size = 1.5;
    for (const attachment_id of ["4", "5"]) {
      await expectCode(
        box.sendMail({ ...msg, attachments: [{ message_id: source, attachment_id: "3" }, { message_id: source, attachment_id }, { filename: "a.txt", text: "ab" }] }),
        "upstream_rejected",
      );
    }
    expect(uploads()).toHaveLength(0);
    expect(fake.sent(A)).toEqual([]);
    expect(await sendsCounted(stub)).toBe(0);
  });
});

describe("attachments: dedupe", () => {
  it("the same message with another attachment, or the same name with other content, is another send", async () => {
    const { stub, box } = await signIn(A);
    const source = messageOfA([
      { name: "a.pdf", type: "application/pdf", content: PDF },
      { name: "b.pdf", type: "application/pdf", content: PDF },
    ]);
    const variants: OutgoingMessage[] = [
      { ...msg },
      { ...msg, attachments: [{ filename: "a.txt", text: "one" }] },
      { ...msg, attachments: [{ filename: "a.txt", text: "two" }] },
      { ...msg, attachments: [{ filename: "b.txt", text: "two" }] },
      { ...msg, attachments: [{ filename: "b.txt", text: "two", content_type: "text/csv" }] },
      { ...msg, attachments: [{ filename: "b.txt", base64: base64(bytes("two")), content_type: "text/csv" }] },
      { ...msg, attachments: [{ message_id: source, attachment_id: "3" }] },
      { ...msg, attachments: [{ message_id: source, attachment_id: "4" }] },
      { ...msg, attachments: [{ message_id: source, attachment_id: "4" }, { message_id: source, attachment_id: "3" }] },
    ];
    for (const v of variants) expect(await box.sendMail(v)).toMatchObject({ deduplicated: false });
    expect(fake.sent(A)).toHaveLength(variants.length);
    expect(await sendsCounted(stub)).toBe(variants.length);
  });

  it("an identical call goes out once and the second one uploads nothing", async () => {
    const { stub, box } = await signIn(A);
    const source = messageOfA([{ name: "a.pdf", type: "application/pdf", content: PDF }]);
    const message: OutgoingMessage = {
      ...msg,
      attachments: [
        { filename: "a.txt", text: "same" },
        { filename: "p.png", base64: base64(PNG), content_type: "image/png" },
        { message_id: source, attachment_id: "3" },
      ],
    };
    const first = await box.sendMail(message);
    expect(uploads()).toHaveLength(2);
    const lookups = jmapRequests().length;
    expect(await box.sendMail(message)).toEqual({ ...first, deduplicated: true });
    expect(uploads()).toHaveLength(2);
    expect(jmapRequests()).toHaveLength(lookups);
    expect(fake.sent(A)).toHaveLength(1);
    expect(await sendsCounted(stub)).toBe(1);
    // Padding does not make another file.
    const padded: OutgoingMessage = { ...msg, attachments: [{ filename: "d.pdf", base64: base64(PDF), content_type: "application/pdf" }] };
    expect(base64(PDF)).toMatch(/=$/);
    await box.sendMail(padded);
    const unpadded: OutgoingMessage = {
      ...msg,
      attachments: [{ filename: "d.pdf", base64: base64(PDF).replace(/=+$/, ""), content_type: "application/pdf" }],
    };
    expect(await box.sendMail(unpadded)).toMatchObject({ deduplicated: true, attachments: 1 });
    expect(fake.sent(A)).toHaveLength(2);
  });

  it("two identical calls at once: one send, the second awaits the first", async () => {
    const { box } = await signIn(A);
    const message: OutgoingMessage = { ...msg, attachments: [{ filename: "a.txt", text: "same" }] };
    const [one, two] = await Promise.all([box.sendMail(message), box.sendMail(message)]);
    expect(two.message_id).toBe(one.message_id);
    expect(uploads()).toHaveLength(1);
    expect(fake.sent(A)).toHaveLength(1);
  });

  it("without attachments the fingerprint is the one it was", async () => {
    const plain: OutgoingMessage = { ...msg };
    expect(await sendFingerprint(plain, [])).toBe(await sendFingerprint(plain));
    const before = JSON.stringify([[OK], [], [], "Files", "See attached.", null]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(before));
    expect(await sendFingerprint(plain)).toBe([...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join(""));
  });
});

describe("attachments: none", () => {
  it("an empty list sends byte for byte the requests sent without the field", async () => {
    const { box } = await signIn(A);
    const bodies = async (m: OutgoingMessage) => {
      const from = fake.requests.length;
      await box.createDraft(m);
      // The session is fetched once per vault instance; the requests that follow are compared.
      return fake.requests
        .slice(from)
        .filter((r) => r.url !== STALWART.session)
        .map((r) => JSON.stringify([r.url, r.method, r.body]));
    };
    const without = await bodies({ ...msg });
    const empty = await bodies({ ...msg, attachments: [] });
    expect(empty).toEqual(without);
    expect(without.join()).not.toContain("attachments");
    expect(uploads()).toHaveLength(0);
  });
});

describe("attachments: the session's upload URL", () => {
  async function adapterWith(uploadUrl: unknown): Promise<{ adapter: JmapMailboxAdapter; session: JmapSession }> {
    fake.addMailbox(A);
    const { accessToken } = fake.tokensFor(A);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      if (new Request(input, init).url !== STALWART.session) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return Response.json({ ...body, uploadUrl });
    });
    const session = await fetchSession(accessToken);
    vi.stubGlobal("fetch", fake.fetch);
    return { adapter: new JmapMailboxAdapter({ accountId: session.accountId, accessToken, session }), session };
  }

  const upload = { name: "a.txt", type: "text/plain", charset: "utf-8" as const, bytes: bytes("a"), sha256: "x" };
  const prepared = (attachments: Parameters<JmapMailboxAdapter["createDraft"]>[0]["attachments"]) => ({
    ...msg,
    body: "b",
    attachments,
  });

  it("is taken from the session when it is on Stalwart's origin and names {accountId}", async () => {
    const { session } = await adapterWith(`${STALWART.origin}/jmap/upload/{accountId}/`);
    expect(session.uploadUrl).toBe(`${STALWART.origin}/jmap/upload/{accountId}/`);
  });

  it("without a usable one: mailbox_unsupported before any request, and no request there", async () => {
    for (const uploadUrl of [`${EVIL}/jmap/upload/{accountId}/`, `${STALWART.origin}/jmap/upload/fixed/`, 42, undefined]) {
      fake = createFakeStalwart();
      const { adapter, session } = await adapterWith(uploadUrl);
      expect(session.uploadUrl).toBeNull();
      const before = fake.requests.length;
      await expectCode(adapter.createDraft(prepared([upload])), "mailbox_unsupported");
      await expectCode(adapter.sendMail(prepared([upload])), "mailbox_unsupported");
      expect(fake.requests).toHaveLength(before);
      // A stored file needs no upload.
      const source = messageOfA([{ name: "a.pdf", type: "application/pdf", content: PDF }]);
      expect(await adapter.createDraft(prepared([{ message_id: source, attachment_id: "3" }]))).toMatchObject({ attachments: 1 });
    }
  });

  it("a stored or hand-made session with a foreign template is refused the same way", async () => {
    const { session } = await adapterWith(`${STALWART.origin}/jmap/upload/{accountId}/`);
    const forged: JmapSession = { ...session, uploadUrl: `${EVIL}/{accountId}/` };
    const adapter = new JmapMailboxAdapter({ accountId: session.accountId, accessToken: fake.tokensFor(A).accessToken, session: forged });
    const before = fake.requests.length;
    await expectCode(adapter.createDraft(prepared([upload])), "mailbox_unsupported");
    expect(fake.requests).toHaveLength(before);
  });

  it("an upload answer for another account, with a blob id that is not an id or another size is upstream_rejected", async () => {
    const { adapter } = await adapterWith(`${STALWART.origin}/jmap/upload/{accountId}/`);
    for (const change of [{ accountId: "acc999" }, { blobId: "../x" }, { size: 99 }, { blobId: 7 }]) {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await fake.fetch(input, init);
        if (!new URL(new Request(input, init).url).pathname.startsWith("/jmap/upload/")) return res;
        return Response.json({ ...((await res.json()) as object), ...change }, { status: 201 });
      });
      await expectCode(adapter.createDraft(prepared([upload])), "upstream_rejected");
    }
    expect(emailSets()).toHaveLength(0);
  });

  it("accepts a 200 answer to the upload as well as 201", async () => {
    const { adapter } = await adapterWith(`${STALWART.origin}/jmap/upload/{accountId}/`);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      if (!new URL(new Request(input, init).url).pathname.startsWith("/jmap/upload/")) return res;
      return Response.json(await res.json(), { status: 200 });
    });
    expect(await adapter.createDraft(prepared([upload]))).toMatchObject({ attachments: 1 });
  });

  it("an unknown blob in Email/set is the server's refusal: upstream_rejected", async () => {
    const { adapter } = await adapterWith(`${STALWART.origin}/jmap/upload/{accountId}/`);
    const source = messageOfA([{ name: "a.pdf", type: "application/pdf", content: PDF }]);
    // The lookup names a blob the server does not hold.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      const body = init?.body;
      if (typeof body !== "string" || !body.includes('"bodyProperties"')) return res;
      return new Response((await res.text()).replace(/"blobId":"[^"]+"/g, '"blobId":"blobgone"'), res);
    });
    await expectCode(adapter.createDraft(prepared([{ message_id: source, attachment_id: "3" }])), "upstream_rejected");
    expect(emailSets()).toHaveLength(1);
  });
});
