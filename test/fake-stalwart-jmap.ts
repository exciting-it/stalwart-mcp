/**
 * JMAP method handlers of the fake Stalwart (RFC 8620 core, RFC 8621 mail and submission).
 * Implements what the mail-mcp worker depends on: back-references, per-account scoping with
 * `accountNotFound`, `notFound` lists, method errors as `["error", {type}, callId]`,
 * `created`/`notCreated` in `/set` answers and `onSuccessUpdateEmail`.
 */
import type { JmapInvocation } from "../src/jmap/jmap-client";
import { COLLAB_CAPABILITIES, COLLAB_METHODS } from "./fake-stalwart-collab";
import type { FakeAccount, FakeAddress, FakeAttachment, FakeEmail, FakeState } from "./fake-stalwart-state";
import {
  type Args,
  contains,
  type Ctx,
  type FakeArea,
  type Handler,
  ids,
  isObject,
  type MethodEntry,
  MethodError,
  pick,
} from "./fake-stalwart-support";

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";

type SetError = { type: string; properties?: string[] };

const clone = <T>(v: T): T => structuredClone(v);

// ---- request envelope ----

export function handleJmapRequest(
  state: FakeState,
  account: FakeAccount,
  body: unknown,
  /** The areas the request's token has a scope for (contacts, calendars); mail is always served. */
  areas: ReadonlySet<FakeArea>,
): { status: number; body: unknown } {
  const notRequest = { status: 400, body: { type: "urn:ietf:params:jmap:error:notRequest", status: 400 } };
  if (!isObject(body) || !Array.isArray(body.using) || !Array.isArray(body.methodCalls)) return notRequest;
  const using = new Set(body.using as unknown[]);
  for (const cap of using) {
    if (cap !== CORE && cap !== MAIL && cap !== SUBMISSION && !(Object.values(COLLAB_CAPABILITIES) as unknown[]).includes(cap)) {
      return { status: 400, body: { type: "urn:ietf:params:jmap:error:unknownCapability", status: 400 } };
    }
  }
  const out: JmapInvocation[] = [];
  const createdIds = new Map<string, string>();
  for (const call of body.methodCalls as unknown[]) {
    if (!Array.isArray(call) || call.length !== 3 || typeof call[0] !== "string" || !isObject(call[1]) || typeof call[2] !== "string") {
      return notRequest;
    }
    const [name, rawArgs, callId] = call as [string, Args, string];
    const ctx: Ctx = { state, account, callId, out, createdIds };
    try {
      const method = METHODS[name];
      // A method is served only when its capability is in `using` and, for contacts and
      // calendars, the token's scopes include the area.
      if (!method || !using.has(method.capability) || (method.area && !areas.has(method.area))) {
        throw new MethodError("unknownMethod");
      }
      const args = resolveBackReferences(rawArgs, out);
      if (args.accountId !== account.accountId) throw new MethodError("accountNotFound");
      method.handler(args, ctx);
    } catch (e) {
      if (!(e instanceof MethodError)) throw e;
      out.push(["error", { type: e.type }, callId]);
    }
  }
  return { status: 200, body: { methodResponses: out, sessionState: "fake-session-1" } };
}

function resolveBackReferences(args: Args, responses: JmapInvocation[]): Args {
  const resolved: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      resolved[key] = value;
      continue;
    }
    const plain = key.slice(1);
    if (plain in args) throw new MethodError("invalidArguments");
    if (!isObject(value) || typeof value.resultOf !== "string" || typeof value.name !== "string" || typeof value.path !== "string") {
      throw new MethodError("invalidResultReference");
    }
    const source = responses.find((r) => r[2] === value.resultOf);
    if (!source || source[0] !== value.name) throw new MethodError("invalidResultReference");
    resolved[plain] = evaluatePointer(source[1], value.path);
  }
  return resolved;
}

/** JSON pointer with the JMAP `*` extension (RFC 8620 §3.7). */
function evaluatePointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  if (!path.startsWith("/")) throw new MethodError("invalidResultReference");
  const parts = path.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  const walk = (v: unknown, rest: string[]): unknown => {
    if (rest.length === 0) return v;
    const [head, ...tail] = rest as [string, ...string[]];
    if (Array.isArray(v)) {
      if (head === "*") return v.flatMap((item) => {
        const r = walk(item, tail);
        return Array.isArray(r) ? r : [r];
      });
      const i = Number(head);
      if (!Number.isInteger(i) || i < 0 || i >= v.length) throw new MethodError("invalidResultReference");
      return walk(v[i], tail);
    }
    if (isObject(v) && head in v) return walk(v[head], tail);
    throw new MethodError("invalidResultReference");
  };
  return walk(value, parts);
}

// ---- helpers ----

function isUnread(e: FakeEmail): boolean {
  return !e.keywords.$seen;
}

function threadEmails(account: FakeAccount, threadId: string): FakeEmail[] {
  return [...account.emails.values()]
    .filter((e) => e.threadId === threadId)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || idOrder(a.id, b.id));
}

function idOrder(a: string, b: string): number {
  return Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""));
}

// ---- Mailbox/get ----

const MAILBOX_PROPS = [
  "id", "name", "parentId", "role", "sortOrder", "totalEmails", "unreadEmails", "totalThreads",
  "unreadThreads", "myRights", "isSubscribed",
] as const;

const mailboxGet: Handler = (args, { account, callId, out }) => {
  const wanted = ids(args);
  const list: Args[] = [];
  const notFound: string[] = [];
  const all = [...account.folders.values()];
  for (const id of wanted ?? all.map((f) => f.id)) {
    const f = account.folders.get(id);
    if (!f) {
      notFound.push(id);
      continue;
    }
    const inside = [...account.emails.values()].filter((e) => e.mailboxIds[f.id]);
    const threads = new Set(inside.map((e) => e.threadId));
    const unreadThreads = new Set(inside.filter(isUnread).map((e) => e.threadId));
    const full: Args = {
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      role: f.role,
      sortOrder: 0,
      totalEmails: inside.length,
      unreadEmails: inside.filter(isUnread).length,
      totalThreads: threads.size,
      unreadThreads: unreadThreads.size,
      myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
      isSubscribed: true,
    };
    list.push(pick(full, args.properties, MAILBOX_PROPS));
  }
  out.push(["Mailbox/get", { accountId: account.accountId, state: "mb-state", list, notFound }, callId]);
};

// ---- Email/query ----

const FILTER_KEYS = new Set([
  "inMailbox", "text", "from", "to", "cc", "bcc", "subject", "body", "after", "before",
  "hasKeyword", "notKeyword", "hasAttachment",
]);

const addressesContain = (list: FakeAddress[], needle: string) =>
  list.some((a) => contains(a.name, needle) || contains(a.email, needle));

function matches(e: FakeEmail, filter: unknown): boolean {
  if (filter === null || filter === undefined) return true;
  if (!isObject(filter)) throw new MethodError("invalidArguments");
  if ("operator" in filter) {
    const conditions = filter.conditions;
    if (!Array.isArray(conditions)) throw new MethodError("invalidArguments");
    const results = conditions.map((c) => matches(e, c));
    if (filter.operator === "AND") return results.every(Boolean);
    if (filter.operator === "OR") return results.some(Boolean);
    if (filter.operator === "NOT") return !results.some(Boolean);
    throw new MethodError("unsupportedFilter");
  }
  for (const [k, v] of Object.entries(filter)) {
    if (!FILTER_KEYS.has(k)) throw new MethodError("unsupportedFilter");
    const s = String(v);
    const ok =
      k === "inMailbox" ? e.mailboxIds[s] === true
      : k === "text" ? contains(e.subject, s) || contains(e.text, s) || contains(e.html, s) || addressesContain([...e.from, ...e.to, ...e.cc], s)
      : k === "from" ? addressesContain(e.from, s)
      : k === "to" ? addressesContain(e.to, s)
      : k === "cc" ? addressesContain(e.cc, s)
      : k === "bcc" ? addressesContain(e.bcc, s)
      : k === "subject" ? contains(e.subject, s)
      : k === "body" ? contains(e.text, s) || contains(e.html, s)
      : k === "after" ? Date.parse(e.receivedAt) >= Date.parse(s)
      : k === "before" ? Date.parse(e.receivedAt) < Date.parse(s)
      : k === "hasKeyword" ? e.keywords[s] === true
      : k === "notKeyword" ? e.keywords[s] !== true
      : (e.attachments.length > 0) === (v === true);
    if (!ok) return false;
  }
  return true;
}

const emailQuery: Handler = (args, { account, callId, out }) => {
  const sort = args.sort ?? [];
  if (!Array.isArray(sort)) throw new MethodError("invalidArguments");
  let ascending = true;
  for (const s of sort) {
    if (!isObject(s) || s.property !== "receivedAt") throw new MethodError("unsupportedSort");
    ascending = s.isAscending !== false;
  }
  const found = [...account.emails.values()]
    .filter((e) => matches(e, args.filter))
    .sort((a, b) => (a.receivedAt.localeCompare(b.receivedAt) || idOrder(a.id, b.id)) * (ascending ? 1 : -1));
  const position = typeof args.position === "number" ? args.position : 0;
  if (!Number.isInteger(position)) throw new MethodError("invalidArguments");
  const start = position < 0 ? Math.max(0, found.length + position) : position;
  const limit = typeof args.limit === "number" ? args.limit : found.length;
  if (!Number.isInteger(limit) || limit < 0) throw new MethodError("invalidArguments");
  const page = found.slice(start, start + limit).map((e) => e.id);
  const result: Args = {
    accountId: account.accountId,
    queryState: "q-state",
    canCalculateChanges: false,
    position: start,
    ids: page,
  };
  if (args.calculateTotal === true) result.total = found.length;
  out.push(["Email/query", result, callId]);
};

// ---- Email/get ----

const EMAIL_PROPS = [
  "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "messageId",
  "inReplyTo", "references", "from", "to", "cc", "bcc", "replyTo", "subject", "sentAt",
  "hasAttachment", "preview", "bodyValues", "textBody", "htmlBody", "attachments",
] as const;
const PART_PROPS = ["partId", "blobId", "size", "name", "type", "charset", "disposition"];
const DEFAULT_EMAIL_PROPS = EMAIL_PROPS.filter((p) => p !== "bodyValues" && p !== "textBody" && p !== "htmlBody" && p !== "attachments");

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (maxBytes <= 0) return { value, truncated: false };
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return { value, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const ch of value) {
    const n = encoder.encode(ch).length;
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += ch.length;
  }
  return { value: value.slice(0, end), truncated: true };
}

function emailObject(e: FakeEmail, args: Args): Args {
  const utf8 = (s: string | null) => new TextEncoder().encode(s ?? "").length;
  const part = (
    partId: string,
    type: string,
    size: number,
    blobId: string,
    name: string | null = null,
    disposition: string | null = null,
    charset: string | null = type.startsWith("text/") ? "utf-8" : null,
  ) => ({ partId, blobId, size, name, type, charset, disposition });
  const textPart = e.text !== null ? part("1", "text/plain", utf8(e.text), `${e.blobId}-1`) : null;
  const htmlPart = e.html !== null ? part("2", "text/html", utf8(e.html), `${e.blobId}-2`) : null;
  const attachments = e.attachments.map((a, i) =>
    a.charset === undefined
      ? part(a.partId ?? String(i + 3), a.type, a.size, a.blobId, a.name, "attachment")
      : part(a.partId ?? String(i + 3), a.type, a.size, a.blobId, a.name, "attachment", a.charset),
  );
  // RFC 8621 §4.1.4: each list falls back to the other alternative when its own type is absent.
  const textBody = textPart ? [textPart] : htmlPart ? [htmlPart] : [];
  const htmlBody = htmlPart ? [htmlPart] : textPart ? [textPart] : [];

  const maxBytes = typeof args.maxBodyValueBytes === "number" ? args.maxBodyValueBytes : 0;
  const bodyValues: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }> = {};
  const addValues = (parts: typeof textBody) => {
    for (const p of parts) {
      const raw = p.partId === "1" ? e.text : e.html;
      if (raw === null) continue;
      const { value, truncated } = truncateUtf8(raw, maxBytes);
      bodyValues[p.partId] = { value, isEncodingProblem: false, isTruncated: truncated };
    }
  };
  if (args.fetchTextBodyValues === true || args.fetchAllBodyValues === true) addValues(textBody);
  if (args.fetchHTMLBodyValues === true || args.fetchAllBodyValues === true) addValues(htmlBody);

  // `bodyProperties` (RFC 8621 §4.2): the properties of each body part; all of them without it.
  const partProps = (parts: Args[]): Args[] => {
    const wanted = args.bodyProperties;
    if (wanted === undefined || wanted === null) return parts;
    if (!Array.isArray(wanted) || wanted.some((p) => typeof p !== "string" || !PART_PROPS.includes(p))) {
      throw new MethodError("invalidArguments");
    }
    return parts.map((p) => Object.fromEntries((wanted as string[]).map((k) => [k, p[k] ?? null])));
  };

  const full: Args = {
    id: e.id,
    blobId: e.blobId,
    threadId: e.threadId,
    mailboxIds: e.mailboxIds,
    keywords: e.keywords,
    size: utf8(e.text) + utf8(e.html) + e.attachments.reduce((n, a) => n + a.size, 0),
    receivedAt: e.receivedAt,
    messageId: e.messageId,
    inReplyTo: e.inReplyTo,
    references: e.references,
    from: e.from,
    to: e.to,
    cc: e.cc,
    bcc: e.bcc,
    replyTo: null,
    subject: e.subject,
    sentAt: e.receivedAt,
    hasAttachment: e.attachments.length > 0,
    preview: e.preview,
    bodyValues,
    textBody: partProps(textBody),
    htmlBody: partProps(htmlBody),
    attachments: partProps(attachments),
  };
  return clone(pick(full, args.properties ?? DEFAULT_EMAIL_PROPS, EMAIL_PROPS));
}

const emailGet: Handler = (args, { account, callId, out }) => {
  const wanted = ids(args) ?? [...account.emails.keys()];
  const list: Args[] = [];
  const notFound: string[] = [];
  for (const id of wanted) {
    const e = account.emails.get(id);
    if (e) list.push(emailObject(e, args));
    else notFound.push(id);
  }
  out.push(["Email/get", { accountId: account.accountId, state: "em-state", list, notFound }, callId]);
};

// ---- Thread/get ----

const threadGet: Handler = (args, { account, callId, out }) => {
  const list: Args[] = [];
  const notFound: string[] = [];
  for (const id of ids(args) ?? []) {
    const emails = threadEmails(account, id);
    if (emails.length === 0) notFound.push(id);
    else list.push({ id, emailIds: emails.map((e) => e.id) });
  }
  out.push(["Thread/get", { accountId: account.accountId, state: "th-state", list, notFound }, callId]);
};

// ---- Identity/get ----

const identityGet: Handler = (args, { account, callId, out }) => {
  const wanted = ids(args);
  const list: Args[] = [];
  const notFound: string[] = [];
  for (const id of wanted ?? account.identities.map((i) => i.id)) {
    const identity = account.identities.find((i) => i.id === id);
    if (!identity) {
      notFound.push(id);
      continue;
    }
    list.push({ ...identity, replyTo: null, bcc: null, textSignature: "", htmlSignature: "", mayDelete: true });
  }
  out.push(["Identity/get", { accountId: account.accountId, state: "id-state", list, notFound }, callId]);
};

// ---- Email/set ----

const CREATE_KEYS = new Set([
  "mailboxIds", "keywords", "from", "to", "cc", "bcc", "replyTo", "subject", "inReplyTo",
  "references", "messageId", "sentAt", "receivedAt", "bodyValues", "textBody", "htmlBody",
  "attachments",
]);

const ATTACHMENT_KEYS = new Set(["blobId", "type", "name", "disposition", "charset"]);

/**
 * The `attachments` of an `Email/set` create (RFC 8621 §4.6): each part names a blob of this
 * account (an upload, or a part of one of its messages) with its type, name and disposition.
 * A blob the account does not hold, or a malformed part, refuses the create (`invalidProperties`).
 */
function createAttachments(account: FakeAccount, raw: unknown): FakeAttachment[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: FakeAttachment[] = [];
  for (const p of raw as unknown[]) {
    if (!isObject(p) || Object.keys(p).some((k) => !ATTACHMENT_KEYS.has(k))) return null;
    if (typeof p.blobId !== "string" || typeof p.type !== "string" || p.disposition !== "attachment") return null;
    if (p.name !== undefined && p.name !== null && typeof p.name !== "string") return null;
    if (p.charset !== undefined && typeof p.charset !== "string") return null;
    const content =
      account.uploads.find((u) => u.blobId === p.blobId)?.content ??
      [...account.emails.values()].flatMap((e) => e.attachments).find((a) => a.blobId === p.blobId)?.content;
    if (content === undefined) return null;
    const part: FakeAttachment = { blobId: p.blobId, name: (p.name as string | null | undefined) ?? null, size: content.length, type: p.type, content: content.slice() };
    if (typeof p.charset === "string") part.charset = p.charset;
    out.push(part);
  }
  return out;
}

function addressList(v: unknown): FakeAddress[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: FakeAddress[] = [];
  for (const a of v) {
    if (!isObject(a) || typeof a.email !== "string" || (a.name !== null && a.name !== undefined && typeof a.name !== "string")) return null;
    out.push({ name: (a.name as string | null | undefined) ?? null, email: a.email });
  }
  return out;
}

function stringList(v: unknown): string[] | null | false {
  if (v === undefined || v === null) return null;
  return Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : false;
}

function createEmail(account: FakeAccount, state: FakeState, raw: unknown): FakeEmail | SetError {
  const invalid = (property: string): SetError => ({ type: "invalidProperties", properties: [property] });
  if (!isObject(raw)) return { type: "invalidProperties" };
  for (const k of Object.keys(raw)) if (!CREATE_KEYS.has(k)) return invalid(k);
  const mailboxIds = raw.mailboxIds;
  if (!isObject(mailboxIds) || Object.keys(mailboxIds).length === 0) return invalid("mailboxIds");
  for (const [id, on] of Object.entries(mailboxIds)) if (on !== true || !account.folders.has(id)) return invalid("mailboxIds");
  const keywords = raw.keywords ?? {};
  if (!isObject(keywords) || Object.values(keywords).some((v) => v !== true)) return invalid("keywords");
  const addresses: Record<string, FakeAddress[]> = {};
  for (const k of ["from", "to", "cc", "bcc"]) {
    const list = addressList(raw[k]);
    if (list === null) return invalid(k);
    addresses[k] = list;
  }
  if (raw.subject !== undefined && typeof raw.subject !== "string") return invalid("subject");
  const inReplyTo = stringList(raw.inReplyTo);
  const references = stringList(raw.references);
  if (inReplyTo === false) return invalid("inReplyTo");
  if (references === false) return invalid("references");

  const values = isObject(raw.bodyValues) ? raw.bodyValues : {};
  // RFC 8621 §4.6: textBody and htmlBody each hold exactly one part, of type text/plain and
  // text/html; with both the server builds a multipart/alternative message.
  const bodyPart = (list: unknown, type: string): { value: string; type: string } | null | false => {
    if (list === undefined) return null;
    if (!Array.isArray(list) || list.length !== 1 || !isObject(list[0])) return false;
    const p = list[0];
    const v = typeof p.partId === "string" ? values[p.partId] : undefined;
    if (!isObject(v) || typeof v.value !== "string" || p.type !== type) return false;
    return { value: v.value, type: p.type };
  };
  const textBody = bodyPart(raw.textBody, "text/plain");
  const htmlBody = bodyPart(raw.htmlBody, "text/html");
  if (textBody === false) return invalid("textBody");
  if (htmlBody === false) return invalid("htmlBody");
  const parts = [textBody, htmlBody].filter((p): p is { value: string; type: string } => p !== null);
  const text = parts.find((p) => p.type === "text/plain")?.value ?? null;
  const html = parts.find((p) => p.type === "text/html")?.value ?? null;
  const attachments = createAttachments(account, raw.attachments);
  if (attachments === null) return invalid("attachments");

  const id = state.nextId("em");
  const related = [...(inReplyTo ?? []), ...(references ?? [])];
  const parent = [...account.emails.values()].find((e) => e.messageId.some((m) => related.includes(m)));
  return {
    id,
    blobId: state.nextId("bl"),
    threadId: parent?.threadId ?? state.nextId("th"),
    mailboxIds: { ...(mailboxIds as Record<string, true>) },
    keywords: { ...(keywords as Record<string, true>) },
    from: addresses.from ?? [],
    to: addresses.to ?? [],
    cc: addresses.cc ?? [],
    bcc: addresses.bcc ?? [],
    subject: (raw.subject as string | undefined) ?? "",
    receivedAt: state.nextReceivedAt(),
    messageId: [`${id}@fake.stalwart`],
    inReplyTo,
    references,
    text,
    html,
    preview: (text ?? html ?? "").replace(/\s+/g, " ").trim().slice(0, 256),
    attachments,
  };
}

function updateEmail(account: FakeAccount, e: FakeEmail, patch: unknown): SetError | null {
  const invalid = (property: string): SetError => ({ type: "invalidProperties", properties: [property] });
  if (!isObject(patch)) return { type: "invalidPatch" };
  const mailboxIds = { ...e.mailboxIds };
  const keywords = { ...e.keywords };
  for (const [path, value] of Object.entries(patch)) {
    if (path === "keywords" || path === "mailboxIds") {
      if (!isObject(value) || Object.values(value).some((v) => v !== true)) return invalid(path);
      if (path === "mailboxIds" && Object.keys(value).some((id) => !account.folders.has(id))) return invalid(path);
      const target = path === "keywords" ? keywords : mailboxIds;
      for (const k of Object.keys(target)) delete target[k];
      Object.assign(target, value);
      continue;
    }
    const m = /^(keywords|mailboxIds)\/(.+)$/.exec(path);
    if (!m || (value !== true && value !== null)) return invalid(path);
    const [, field, k] = m as unknown as [string, "keywords" | "mailboxIds", string];
    if (field === "mailboxIds" && value === true && !account.folders.has(k)) return invalid(path);
    const target = field === "keywords" ? keywords : mailboxIds;
    if (value === true) target[k] = true;
    else delete target[k];
  }
  if (Object.keys(mailboxIds).length === 0) return invalid("mailboxIds");
  e.mailboxIds = mailboxIds;
  e.keywords = keywords;
  return null;
}

function resolveId(id: string, createdIds: Map<string, string>): string | undefined {
  return id.startsWith("#") ? createdIds.get(id.slice(1)) : id;
}

function applyEmailSet(args: Args, ctx: Ctx): Args {
  const { account, state, createdIds } = ctx;
  const created: Record<string, Args> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  if (args.create !== undefined && args.create !== null) {
    if (!isObject(args.create)) throw new MethodError("invalidArguments");
    for (const [cid, raw] of Object.entries(args.create)) {
      const result = createEmail(account, state, raw);
      if ("type" in result) {
        notCreated[cid] = result;
        continue;
      }
      account.emails.set(result.id, result);
      createdIds.set(cid, result.id);
      created[cid] = { id: result.id, blobId: result.blobId, threadId: result.threadId, size: (result.text ?? "").length };
    }
  }
  if (args.update !== undefined && args.update !== null) {
    if (!isObject(args.update)) throw new MethodError("invalidArguments");
    for (const [rawId, patch] of Object.entries(args.update)) {
      const id = resolveId(rawId, createdIds);
      const e = id === undefined ? undefined : account.emails.get(id);
      if (!e || id === undefined) {
        notUpdated[rawId] = { type: "notFound" };
        continue;
      }
      const error = updateEmail(account, e, patch);
      if (error) notUpdated[id] = error;
      else updated[id] = null;
    }
  }
  if (args.destroy !== undefined && args.destroy !== null) {
    if (!Array.isArray(args.destroy)) throw new MethodError("invalidArguments");
    for (const rawId of args.destroy as unknown[]) {
      const id = typeof rawId === "string" ? resolveId(rawId, createdIds) : undefined;
      if (id !== undefined && account.emails.delete(id)) destroyed.push(id);
      else notDestroyed[String(rawId)] = { type: "notFound" };
    }
  }
  const orNull = (o: object) => (Object.keys(o).length === 0 ? null : o);
  return {
    accountId: account.accountId,
    oldState: "em-state",
    newState: "em-state",
    created: orNull(created),
    updated: orNull(updated),
    destroyed: destroyed.length === 0 ? null : destroyed,
    notCreated: orNull(notCreated),
    notUpdated: orNull(notUpdated),
    notDestroyed: orNull(notDestroyed),
  };
}

const emailSet: Handler = (args, ctx) => {
  ctx.out.push(["Email/set", applyEmailSet(args, ctx), ctx.callId]);
};

// ---- EmailSubmission/set ----

const emailSubmissionSet: Handler = (args, ctx) => {
  const { account, state, callId, out, createdIds } = ctx;
  const created: Record<string, Args> = {};
  const notCreated: Record<string, SetError> = {};
  const submittedEmail = new Map<string, string>(); // submission creation id → email id
  if (args.create !== undefined && args.create !== null) {
    if (!isObject(args.create)) throw new MethodError("invalidArguments");
    for (const [cid, raw] of Object.entries(args.create)) {
      const error = (type: string, properties?: string[]) => (notCreated[cid] = properties ? { type, properties } : { type });
      if (!isObject(raw) || typeof raw.emailId !== "string" || typeof raw.identityId !== "string") {
        error("invalidProperties");
        continue;
      }
      const emailId = resolveId(raw.emailId, createdIds);
      const email = emailId === undefined ? undefined : account.emails.get(emailId);
      const identity = account.identities.find((i) => i.id === raw.identityId);
      if (!email || emailId === undefined) {
        error("invalidProperties", ["emailId"]);
        continue;
      }
      if (!identity) {
        error("invalidProperties", ["identityId"]);
        continue;
      }
      if (email.from.length !== 1 || email.from[0]!.email.toLowerCase() !== identity.email.toLowerCase()) {
        error("forbiddenFrom");
        continue;
      }
      if (email.to.length + email.cc.length + email.bcc.length === 0) {
        error("noRecipients");
        continue;
      }
      if (state.takeSubmissionRejection()) {
        error("forbiddenToSend");
        continue;
      }
      const submissionId = state.nextId("sub");
      account.sent.push(clone({
        submissionId,
        emailId,
        identityId: identity.id,
        from: email.from,
        to: email.to,
        cc: email.cc,
        bcc: email.bcc,
        subject: email.subject,
        text: email.text,
        html: email.html,
        inReplyTo: email.inReplyTo,
        references: email.references,
        attachments: email.attachments.map(({ name, type, size, content }) => ({ name, type, size, content })),
      }));
      submittedEmail.set(cid, emailId);
      createdIds.set(cid, submissionId);
      created[cid] = { id: submissionId, undoStatus: "final", sendAt: email.receivedAt };
    }
  }
  const orNull = (o: object) => (Object.keys(o).length === 0 ? null : o);
  const notChanged = (list: unknown) =>
    Array.isArray(list) ? Object.fromEntries(list.map((id) => [String(id), { type: "notFound" }])) : {};
  const updateIds = isObject(args.update) ? Object.keys(args.update) : [];
  out.push([
    "EmailSubmission/set",
    {
      accountId: account.accountId,
      oldState: "sub-state",
      newState: "sub-state",
      created: orNull(created),
      updated: null,
      destroyed: null,
      notCreated: orNull(notCreated),
      notUpdated: orNull(notChanged(updateIds)),
      notDestroyed: orNull(notChanged(args.destroy)),
    },
    callId,
  ]);

  // RFC 8621 §7.5: on success, an implicit Email/set with the same call id.
  const update: Args = {};
  if (isObject(args.onSuccessUpdateEmail)) {
    for (const [ref, patch] of Object.entries(args.onSuccessUpdateEmail)) {
      const emailId = ref.startsWith("#") ? submittedEmail.get(ref.slice(1)) : undefined;
      if (emailId !== undefined) update[emailId] = patch;
    }
  }
  const destroy: string[] = [];
  if (Array.isArray(args.onSuccessDestroyEmail)) {
    for (const ref of args.onSuccessDestroyEmail as unknown[]) {
      const emailId = typeof ref === "string" && ref.startsWith("#") ? submittedEmail.get(ref.slice(1)) : undefined;
      if (emailId !== undefined) destroy.push(emailId);
    }
  }
  if (Object.keys(update).length > 0 || destroy.length > 0) {
    out.push(["Email/set", applyEmailSet({ accountId: account.accountId, update, destroy }, ctx), callId]);
  }
};

const METHODS: Record<string, MethodEntry> = {
  ...COLLAB_METHODS,
  "Mailbox/get": { capability: MAIL, handler: mailboxGet },
  "Email/query": { capability: MAIL, handler: emailQuery },
  "Email/get": { capability: MAIL, handler: emailGet },
  "Email/set": { capability: MAIL, handler: emailSet },
  "Thread/get": { capability: MAIL, handler: threadGet },
  "Identity/get": { capability: SUBMISSION, handler: identityGet },
  "EmailSubmission/set": { capability: SUBMISSION, handler: emailSubmissionSet },
};
