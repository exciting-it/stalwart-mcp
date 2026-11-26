import { describe, expect, it } from "vitest";

import {
  CreateDraftInput,
  EmailAddressSchema,
  ListMailboxesInput,
  ListMailboxesResult,
  MAIL_ERROR_CODES,
  MAIL_ERROR_MESSAGES,
  MAIL_LIMITS,
  MailError,
  MailIdSchema,
  OutgoingMessageBase,
  ReadThreadInput,
  ReadThreadResult,
  SearchMailInput,
  SearchMailResult,
  SendMailInput,
  UNTRUSTED_CONTENT_NOTICE,
} from "../src/mail";

const addrs = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i}@x.example`);

describe("mail contract", () => {
  it("pins the limits of the design", () => {
    expect(MAIL_LIMITS).toMatchObject({
      sendsPerDay: 50,
      recipientsPerMessage: 10,
      toolCallsPerMinute: 60,
      sendDedupeSeconds: 600,
      searchPageMax: 25,
      previewChars: 200,
      upstreamConcurrency: 2,
      accessTokenTtlSeconds: 3600,
      refreshIdleSeconds: 2_592_000,
      refreshBackoffSeconds: 300,
      auditRetentionDays: 90,
      htmlInputChars: 200_000,
    });
  });

  it("has no account or from field on any tool input", () => {
    for (const s of [
      ListMailboxesInput,
      SearchMailInput,
      ReadThreadInput,
      CreateDraftInput,
      SendMailInput,
    ]) {
      const keys = Object.keys(
        (s as any)._def.schema?.shape ?? (s as any).shape,
      );
      expect(
        keys.filter((k) => /account|from_address|sender|identity/i.test(k)),
      ).toEqual([]);
    }
    expect(
      SendMailInput.safeParse({
        to: ["a@x.example"],
        subject: "s",
        body: "b",
        from: "e@y.example",
      }).success,
    ).toBe(false);
    expect(ListMailboxesInput.safeParse({ account_id: "x" }).success).toBe(false);
  });

  it("exposes the un-refined base as a plain object shared by both inputs", () => {
    expect(Object.keys(OutgoingMessageBase.shape).sort()).toEqual(
      ["attachments", "bcc", "body", "cc", "html", "in_reply_to", "subject", "to"].sort(),
    );
    // base alone applies no refinements
    expect(OutgoingMessageBase.safeParse({ body: "b" }).success).toBe(true);
  });

  it("refuses recipient 11 and accepts 10", () => {
    const base = { subject: "s", body: "b" };
    expect(
      SendMailInput.safeParse({
        ...base,
        to: addrs(4, "t"),
        cc: addrs(3, "c"),
        bcc: addrs(3, "b"),
      }).success,
    ).toBe(true);
    expect(
      SendMailInput.safeParse({
        ...base,
        to: addrs(4, "t"),
        cc: addrs(4, "c"),
        bcc: addrs(3, "b"),
      }).success,
    ).toBe(false);
    expect(
      CreateDraftInput.safeParse({
        ...base,
        to: addrs(4, "t"),
        cc: addrs(4, "c"),
        bcc: addrs(3, "b"),
      }).success,
    ).toBe(false);
  });

  it("send needs a recipient, a draft does not", () => {
    const m = { subject: "s", body: "b" };
    expect(SendMailInput.safeParse(m).success).toBe(false);
    expect(SendMailInput.safeParse({ ...m, bcc: ["a@x.example"] }).success).toBe(true);
    const draft = CreateDraftInput.safeParse(m);
    expect(draft.success).toBe(true);
    if (draft.success) expect(draft.data).toMatchObject({ to: [], cc: [], bcc: [] });
  });

  it("subject is required unless in_reply_to is set", () => {
    const m = { to: ["a@x.example"], body: "b" };
    expect(SendMailInput.safeParse(m).success).toBe(false);
    expect(CreateDraftInput.safeParse(m).success).toBe(false);
    expect(SendMailInput.safeParse({ ...m, in_reply_to: "abc123" }).success).toBe(true);
    expect(CreateDraftInput.safeParse({ ...m, in_reply_to: "abc123" }).success).toBe(true);
  });

  it.each([
    "a@x.example\r\nBcc: e@y.example",
    "a@x.example, b@y.example",
    "Eve <e@y.example>",
    "no-at-sign",
  ])("refuses address %j", (v) =>
    expect(EmailAddressSchema.safeParse(v).success).toBe(false),
  );

  it("trims addresses and caps them at 254 chars", () => {
    expect(EmailAddressSchema.parse("  a@x.example ")).toBe("a@x.example");
    const long = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example`;
    expect(long.length).toBeGreaterThan(254);
    expect(EmailAddressSchema.safeParse(long).success).toBe(false);
  });

  it.each(["s\r\nBcc: e@y.example", "s\nx", "s\rx"])(
    "refuses CR or LF in a subject %j",
    (subject) => {
      const m = { to: ["a@x.example"], body: "b", subject };
      expect(SendMailInput.safeParse(m).success).toBe(false);
      expect(CreateDraftInput.safeParse(m).success).toBe(false);
    },
  );

  it("caps subject at 255 and body at 100,000 chars", () => {
    const m = { to: ["a@x.example"] };
    expect(SendMailInput.safeParse({ ...m, subject: "s".repeat(255), body: "b" }).success).toBe(true);
    expect(SendMailInput.safeParse({ ...m, subject: "s".repeat(256), body: "b" }).success).toBe(false);
    expect(SendMailInput.safeParse({ ...m, subject: "s", body: "b".repeat(100_000) }).success).toBe(true);
    expect(SendMailInput.safeParse({ ...m, subject: "s", body: "b".repeat(100_001) }).success).toBe(false);
  });

  it("needs body, html or both; html is capped at 200,000 chars", () => {
    const m = { to: ["a@x.example"], subject: "s" };
    for (const schema of [SendMailInput, CreateDraftInput]) {
      expect(schema.safeParse(m).success).toBe(false);
      expect(schema.safeParse({ ...m, body: "b" }).success).toBe(true);
      expect(schema.safeParse({ ...m, html: "<p>h</p>" }).success).toBe(true);
      expect(schema.safeParse({ ...m, body: "b", html: "<p>h</p>" }).success).toBe(true);
      expect(schema.safeParse({ ...m, html: "h".repeat(200_000) }).success).toBe(true);
      expect(schema.safeParse({ ...m, html: "h".repeat(200_001) }).success).toBe(false);
      expect(schema.safeParse({ ...m, html: 1 }).success).toBe(false);
    }
  });

  it.each(["", "a:b", "../x", "a b", "x".repeat(256)])("refuses id %j", (v) =>
    expect(MailIdSchema.safeParse(v).success).toBe(false),
  );

  it("accepts JMAP-style ids", () => {
    expect(MailIdSchema.safeParse("Mabc_123-x").success).toBe(true);
    expect(MailIdSchema.safeParse("x".repeat(255)).success).toBe(true);
  });

  it("search limit defaults to 10 and is capped at 25", () => {
    expect(SearchMailInput.parse({})).toMatchObject({ limit: 10, offset: 0 });
    expect(SearchMailInput.safeParse({ limit: 25 }).success).toBe(true);
    expect(SearchMailInput.safeParse({ limit: 26 }).success).toBe(false);
    expect(SearchMailInput.safeParse({ limit: 0 }).success).toBe(false);
    expect(SearchMailInput.safeParse({ offset: 10_000 }).success).toBe(true);
    expect(SearchMailInput.safeParse({ offset: 10_001 }).success).toBe(false);
  });

  it("search validates dates, filter length and unknown keys", () => {
    expect(SearchMailInput.safeParse({ after: "2026-01-01T00:00:00+01:00" }).success).toBe(true);
    expect(SearchMailInput.safeParse({ after: "yesterday" }).success).toBe(false);
    expect(SearchMailInput.safeParse({ text: "x".repeat(201) }).success).toBe(false);
    expect(SearchMailInput.safeParse({ folder_id: "../x" }).success).toBe(false);
    expect(SearchMailInput.safeParse({ nope: 1 }).success).toBe(false);
  });

  it("read_thread needs a valid thread_id", () => {
    expect(ReadThreadInput.safeParse({ thread_id: "T1" }).success).toBe(true);
    expect(ReadThreadInput.safeParse({ thread_id: "a b" }).success).toBe(false);
    expect(ReadThreadInput.safeParse({}).success).toBe(false);
  });

  it("search and thread results carry the untrusted-content notice", () => {
    expect(SearchMailResult.safeParse({ messages: [], next_offset: null }).success).toBe(false);
    expect(
      SearchMailResult.safeParse({
        messages: [],
        next_offset: null,
        content_notice: UNTRUSTED_CONTENT_NOTICE,
      }).success,
    ).toBe(true);
    expect(
      ReadThreadResult.safeParse({
        thread_id: "T1",
        messages: [],
        omitted_messages: 0,
        content_notice: "other",
      }).success,
    ).toBe(false);
    expect(
      ListMailboxesResult.safeParse({
        address: "a@x.example",
        folders: [{ id: "i", name: "Inbox", role: "inbox", parent_id: null, total: 3, unread: 1 }],
      }).success,
    ).toBe(true);
    // The connected mailbox's address is part of the result, and it is a bare address.
    const folders = [{ id: "i", name: "Inbox", role: "inbox", parent_id: null, total: 3, unread: 1 }];
    expect(ListMailboxesResult.safeParse({ folders }).success).toBe(false);
    expect(ListMailboxesResult.safeParse({ address: "A <a@x.example>", folders }).success).toBe(false);
  });

  it("has a message for every error code and none contains a placeholder", () => {
    for (const c of MAIL_ERROR_CODES)
      expect(MAIL_ERROR_MESSAGES[c]).toMatch(/^[A-Z][^{}$%]+\.$/);
  });

  it("MailError carries only the code and its fixed message", () => {
    const e = new MailError("rate_limited");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("rate_limited");
    expect(e.message).toBe(MAIL_ERROR_MESSAGES.rate_limited);
  });
});
