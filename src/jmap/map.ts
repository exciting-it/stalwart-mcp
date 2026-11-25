/**
 * JMAP objects → tool results. Upstream answers are parsed with the schemas below (anything
 * unexpected is `upstream_rejected`), and every mail-derived string leaves through `clean` or
 * `bodyText` here, so no path can skip the sanitizer.
 */
import {
  MAIL_LIMITS,
  MailError,
  MailIdSchema,
  type MailAddress,
  type MailFolder,
  type MailSummary,
  type SearchMailInputT,
  type ThreadMessage,
} from "../mail";
import { z } from "zod";
import { cleanText, htmlToText } from "../content/sanitize";

const LIMITS = { subject: 998, name: 200, address: 320, type: 255, date: 64 } as const;

/** Every mail-derived string except bodies goes through here. */
function clean(value: string, maxChars: number): string {
  return cleanText(value, maxChars).text;
}

// ---- upstream shapes (RFC 8621) ----

const Id = MailIdSchema;
const IdMap = z.record(z.string(), z.boolean());

const JmapAddress = z.object({ name: z.string().nullish(), email: z.string().nullish() });
const AddressList = z.array(JmapAddress).nullish();

export const JmapMailbox = z.object({
  id: Id,
  name: z.string(),
  role: z.string().nullish(),
  parentId: Id.nullish(),
  totalEmails: z.number().int(),
  unreadEmails: z.number().int(),
});

export const JmapEmailSummary = z.object({
  id: Id,
  threadId: Id,
  mailboxIds: IdMap,
  keywords: IdMap.nullish(),
  from: AddressList,
  to: AddressList,
  subject: z.string().nullish(),
  receivedAt: z.string(),
  preview: z.string().nullish(),
  hasAttachment: z.boolean().nullish(),
});

const BodyPart = z.object({ partId: z.string().nullish(), type: z.string() });
const Attachment = z.object({ name: z.string().nullish(), size: z.number(), type: z.string() });

export const JmapEmailFull = z.object({
  id: Id,
  from: AddressList,
  to: AddressList,
  cc: AddressList,
  subject: z.string().nullish(),
  receivedAt: z.string(),
  textBody: z.array(BodyPart).nullish(),
  htmlBody: z.array(BodyPart).nullish(),
  bodyValues: z.record(z.string(), z.object({ value: z.string(), isTruncated: z.boolean().nullish() })).nullish(),
  attachments: z.array(Attachment).nullish(),
});

export const JmapThread = z.object({ id: Id, emailIds: z.array(Id) });

export const JmapMailboxRole = z.object({ id: Id, role: z.string().nullish() });

export const JmapIdentity = z.object({ id: Id, name: z.string().nullish(), email: z.string() });

export const JmapReplySource = z.object({
  id: Id,
  messageId: z.array(z.string()).nullish(),
  references: z.array(z.string()).nullish(),
  subject: z.string().nullish(),
});

export const SUMMARY_PROPERTIES = [
  "id", "threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment",
] as const;
export const THREAD_MESSAGE_PROPERTIES = [
  "id", "from", "to", "cc", "subject", "receivedAt", "textBody", "htmlBody", "bodyValues", "attachments",
] as const;

/** Parses an upstream value; a shape we do not expect is the server's fault, never a TypeError. */
export function parseUpstream<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MailError("upstream_rejected");
  return parsed.data;
}

/** The `list` and `notFound` of a `/get` answer. */
export function getResult<T>(item: z.ZodType<T>, args: unknown): { list: T[]; notFound: string[] } {
  const parsed = parseUpstream(
    z.object({ list: z.array(item), notFound: z.array(z.string()).nullish() }),
    args,
  );
  return { list: parsed.list, notFound: parsed.notFound ?? [] };
}

/** The server id of `creationId` in a `/set` answer, or null when it was not created. */
export function createdId(args: unknown, creationId: string): string | null {
  const parsed = z
    .object({ created: z.record(z.string(), z.object({ id: Id })).nullish() })
    .safeParse(args);
  if (!parsed.success) return null;
  return parsed.data.created?.[creationId]?.id ?? null;
}

/** What a `/set` answer says about each id of an `update`: done, or refused with a reason. */
export function updateResult(args: unknown): { updated: Set<string>; refused: Map<string, string> } {
  const parsed = parseUpstream(
    z.object({
      updated: z.record(z.string(), z.unknown()).nullish(),
      notUpdated: z.record(z.string(), z.object({ type: z.string() })).nullish(),
    }),
    args,
  );
  return {
    updated: new Set(Object.keys(parsed.updated ?? {})),
    refused: new Map(Object.entries(parsed.notUpdated ?? {}).map(([id, error]) => [id, error.type])),
  };
}

/** True when a `/set` answer lists `creationId` under `notCreated`: the server refused it. */
export function notCreated(args: unknown, creationId: string): boolean {
  const parsed = z.object({ notCreated: z.record(z.string(), z.unknown()).nullish() }).safeParse(args);
  return parsed.success && parsed.data.notCreated?.[creationId] !== undefined;
}

/** A Message-ID as copied into outbound headers: no whitespace or angle brackets, at most 250 characters. */
const HEADER_MESSAGE_ID = /^[^\s<>]{1,250}$/;
const REFERENCES_MAX = 20;

/**
 * `inReplyTo` and `references` of a reply to `original`. The ids come from a third party's message
 * and go into our outbound headers, so only well-formed ones pass; `references` keeps the last 20.
 * Without a usable id of the original there is nothing to thread to.
 */
export function replyThreading(original: z.infer<typeof JmapReplySource>): Record<string, string[]> {
  const usable = (ids: string[] | null | undefined) => (ids ?? []).filter((id) => HEADER_MESSAGE_ID.test(id));
  const messageId = usable(original.messageId);
  if (messageId.length === 0) return {};
  return {
    inReplyTo: messageId,
    references: [...usable(original.references), ...messageId].slice(-REFERENCES_MAX),
  };
}

// ---- mapping ----

const trueKeys = (m: Record<string, boolean> | null | undefined) =>
  Object.entries(m ?? {}).filter(([, on]) => on).map(([k]) => k);

function toAddresses(list: z.infer<typeof AddressList>): MailAddress[] {
  return (list ?? []).map((a) => ({
    name: a.name == null ? null : clean(a.name, LIMITS.name),
    email: clean(a.email ?? "", LIMITS.address),
  }));
}

export function toFolder(m: z.infer<typeof JmapMailbox>): MailFolder {
  return {
    id: m.id,
    name: clean(m.name, LIMITS.name),
    role: m.role == null ? null : clean(m.role, LIMITS.name),
    parent_id: m.parentId ?? null,
    total: m.totalEmails,
    unread: m.unreadEmails,
  };
}

export function toSummary(e: z.infer<typeof JmapEmailSummary>): MailSummary {
  const keywords = e.keywords ?? {};
  return {
    id: e.id,
    thread_id: e.threadId,
    folder_ids: trueKeys(e.mailboxIds),
    from: toAddresses(e.from),
    to: toAddresses(e.to),
    subject: clean(e.subject ?? "", LIMITS.subject),
    date: clean(e.receivedAt, LIMITS.date),
    preview: clean(e.preview ?? "", MAIL_LIMITS.previewChars),
    unread: keywords.$seen !== true,
    flagged: keywords.$flagged === true,
    answered: keywords.$answered === true,
    draft: keywords.$draft === true,
    has_attachment: e.hasAttachment === true,
  };
}

/**
 * The one place a body becomes text: the text/plain part if there is one, otherwise the HTML
 * part through `htmlToText`; both always through `cleanText`, because `htmlToText` alone keeps
 * bidi, zero-width and control characters.
 */
export function bodyText(e: z.infer<typeof JmapEmailFull>): { text: string; truncated: boolean } {
  const values = e.bodyValues ?? {};
  const parts = [...(e.textBody ?? []), ...(e.htmlBody ?? [])];
  const plain = parts.find((p) => p.type === "text/plain" && p.partId != null && values[p.partId]);
  const html = parts.find((p) => p.type === "text/html" && p.partId != null && values[p.partId]);
  const chosen = plain ?? html;
  const value = chosen?.partId == null ? undefined : values[chosen.partId];
  if (!chosen || !value) return { text: "", truncated: false };
  const raw = chosen === plain ? value.value : htmlToText(value.value);
  const cleaned = cleanText(raw, MAIL_LIMITS.bodyChars);
  return { text: cleaned.text, truncated: cleaned.truncated || value.isTruncated === true };
}

export function toThreadMessage(e: z.infer<typeof JmapEmailFull>): ThreadMessage {
  const body = bodyText(e);
  return {
    id: e.id,
    from: toAddresses(e.from),
    to: toAddresses(e.to),
    cc: toAddresses(e.cc),
    date: clean(e.receivedAt, LIMITS.date),
    subject: clean(e.subject ?? "", LIMITS.subject),
    body: body.text,
    body_truncated: body.truncated,
    attachments: (e.attachments ?? []).map((a) => ({
      name: a.name == null ? null : clean(a.name, LIMITS.name),
      size: a.size,
      type: clean(a.type, LIMITS.type),
    })),
  };
}

/** Subject of a reply: the original (cleaned) with `Re: ` unless it already starts with `Re:`. */
export function replySubject(original: string | null | undefined): string {
  const subject = clean(original ?? "", LIMITS.subject).replace(/[\r\n]+/g, " ").trim();
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Search input → JMAP `Email/query` FilterCondition. */
export function searchFilter(input: SearchMailInputT): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (input.text !== undefined) f.text = input.text;
  if (input.from !== undefined) f.from = input.from;
  if (input.to !== undefined) f.to = input.to;
  if (input.subject !== undefined) f.subject = input.subject;
  // The input may carry an offset; JMAP's UTCDate must be UTC.
  if (input.after !== undefined) f.after = new Date(input.after).toISOString();
  if (input.before !== undefined) f.before = new Date(input.before).toISOString();
  if (input.folder_id !== undefined) f.inMailbox = input.folder_id;
  if (input.unread === true) f.notKeyword = "$seen";
  if (input.unread === false) f.hasKeyword = "$seen";
  if (input.has_attachment !== undefined) f.hasAttachment = input.has_attachment;
  return f;
}
