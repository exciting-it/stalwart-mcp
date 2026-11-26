/**
 * `MailboxAdapter` over JMAP for one mailbox. Built per call with that mailbox's own access
 * token and the account id from the OAuth grant; every method call carries that account id,
 * so the adapter cannot act on another account. It never destroys anything and never calls a
 * `/set` method other than `Email/set` create/update and `EmailSubmission/set` create. Deleting
 * a message means moving it to the Trash folder. It downloads only attachments of this account,
 * by a blob id the server named for them, through the session's download template, and uploads
 * only the files of an outgoing message the vault prepared, through the session's upload template.
 */
import {
  type AttachmentDelivery,
  MAIL_LIMITS,
  MailError,
  MailIdSchema,
  type MailboxAdapter,
  type MailFolder,
  type MailSummary,
  type MarkMailInputT,
  type MarkMailOutcome,
  type MoveMailOutcome,
  type MoveMailRequestT,
  isAttachmentFileName,
  isExecutableName,
  type PreparedAttachment,
  type PreparedMessage,
  type ReadAttachmentInputT,
  type ReadThreadInputT,
  type SearchMailInputT,
  type ThreadMessage,
} from "../mail";
import { z } from "zod";
import { attachmentContent, plainType } from "../content/attachment";
import {
  downloadBlob,
  jmapCall,
  methodResult,
  type JmapInvocation,
  type JmapSession,
  uploadBlob,
  usableDownloadUrl,
  usableUploadUrl,
} from "./jmap-client";
import {
  ATTACHMENT_PART_PROPERTIES,
  attachmentName,
  createdId,
  getResult,
  hasFile,
  JmapEmailAttachments,
  JmapEmailFull,
  JmapEmailSummary,
  JmapIdentity,
  JmapMailbox,
  JmapMailboxRole,
  JmapReplySource,
  JmapThread,
  notCreated,
  parseUpstream,
  replySubject,
  replyThreading,
  searchFilter,
  SUMMARY_PART_PROPERTIES,
  SUMMARY_PROPERTIES,
  THREAD_MESSAGE_PROPERTIES,
  toFolder,
  toSummary,
  toThreadMessage,
  updateResult,
} from "./map";

const MAX_BODY_VALUE_BYTES = 262_144;

type Call = [name: string, args: Record<string, unknown>, callId: string];

interface Outgoing {
  email: Record<string, unknown>;
  identityId: string;
  draftsId: string;
  sentId: string | null;
}

/**
 * The body of the Email: one text/plain part, or with HTML a text/plain and a text/html part,
 * which the server sends as multipart/alternative (RFC 8621 §4.6).
 */
function bodyOf(text: string, html: string | undefined): Record<string, unknown> {
  if (html === undefined) {
    return { bodyValues: { body: { value: text } }, textBody: [{ partId: "body", type: "text/plain" }] };
  }
  return {
    bodyValues: { body: { value: text }, html: { value: html } },
    textBody: [{ partId: "body", type: "text/plain" }],
    htmlBody: [{ partId: "html", type: "text/html" }],
  };
}

type StoredRef = Extract<PreparedAttachment, { message_id: string }>;
type Upload = Exclude<PreparedAttachment, StoredRef>;
const isStored = (a: PreparedAttachment): a is StoredRef => "message_id" in a;

/** A charset the server reported for a stored text part, passed on when it is a plain token. */
const CHARSET_TOKEN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** The characters a written name may not have, beyond the path separators. */
const NAME_FORBIDDEN = /["*:<>?|]/g;

/**
 * The name a stored attachment goes out with. Only its last path segment counts (what follows the
 * last `/` or `\`); that is cleaned to one line (`attachmentName`: control and invisible
 * characters removed, line breaks and tabs made spaces, capped), each character a written name
 * may not have becomes `_` (so a received `Re: invoice?.pdf` can be passed on), and white space
 * and dots are stripped at both ends. Nothing left: `attachment`. Otherwise it must meet the rule
 * of a written name (`isAttachmentFileName`). It is refused (`invalid_input`) when it ends like a
 * program: as stored, with those characters taken out (`x.exe"`), or up to its first `:`
 * (`x.exe::$DATA`).
 */
function outgoingStoredName(name: string | null | undefined): string {
  const segment = (name ?? "").split(/[/\\]/).at(-1) ?? "";
  const cleaned = (attachmentName(segment) ?? "").replace(NAME_FORBIDDEN, "_").replace(/^[\s.]+|[\s.]+$/gu, "");
  if (cleaned === "") return "attachment";
  const program = [segment, segment.replace(NAME_FORBIDDEN, ""), segment.split(":")[0] ?? ""].some(isExecutableName);
  if (program || !isAttachmentFileName(cleaned)) throw new MailError("invalid_input");
  return cleaned;
}

/** One entry of the Email's `attachments` (RFC 8621 §4.6); the server builds the MIME structure. */
function attachmentPart(blobId: string, type: string, name: string, charset: string | null): Record<string, unknown> {
  const part: Record<string, unknown> = { blobId, type, name, disposition: "attachment" };
  if (charset !== null) part.charset = charset;
  return part;
}

export class JmapMailboxAdapter implements MailboxAdapter<PreparedMessage> {
  readonly #accountId: string;
  readonly #accessToken: string;
  readonly #session: JmapSession;

  constructor(opts: { accountId: string; accessToken: string; session: JmapSession }) {
    if (opts.session.accountId !== opts.accountId) throw new MailError("account_mismatch");
    this.#accountId = opts.accountId;
    this.#accessToken = opts.accessToken;
    this.#session = opts.session;
  }

  /** The single exit to JMAP: the constructor's account id overrides anything in `args`. */
  #call(calls: Call[], options: { outcomeUnknown?: "send_unconfirmed" } = {}): Promise<JmapInvocation[]> {
    return jmapCall(
      this.#session,
      this.#accessToken,
      calls.map(([name, args, callId]) => [name, { ...args, accountId: this.#accountId }, callId]),
      options,
    );
  }

  async listMailboxes(): Promise<{ folders: MailFolder[] }> {
    const responses = await this.#call([
      ["Mailbox/get", { ids: null, properties: ["id", "name", "role", "parentId", "totalEmails", "unreadEmails"] }, "m"],
    ]);
    const { list } = getResult(JmapMailbox, methodResult(responses, "m", "Mailbox/get"));
    return { folders: list.map(toFolder) };
  }

  /**
   * One page of the search: at most `count` summaries from `position`, newest first, and whether
   * the search has more behind them. Null for a folder that is not this account's. `ids` are the
   * positions looked at; a message deleted between the query and the get has no summary.
   */
  async #summaries(
    input: SearchMailInputT,
    position: number,
    count: number,
  ): Promise<{ ids: string[]; byId: Map<string, z.infer<typeof JmapEmailSummary>>; more: boolean } | null> {
    // A folder id from the input is looked up in the same request: only a folder that is not
    // this account's turns the query's error into an empty page.
    const folderCheck: Call[] =
      input.folder_id === undefined ? [] : [["Mailbox/get", { ids: [input.folder_id], properties: ["id"] }, "f"]];
    const responses = await this.#call([
      ...folderCheck,
      [
        "Email/query",
        {
          filter: searchFilter(input),
          sort: [{ property: "receivedAt", isAscending: false }],
          position,
          limit: count + 1,
        },
        "q",
      ],
      [
        "Email/get",
        {
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: SUMMARY_PROPERTIES,
          bodyProperties: SUMMARY_PART_PROPERTIES,
        },
        "g",
      ],
    ]);
    if (input.folder_id !== undefined) {
      const folder = getResult(JmapMailboxRole, methodResult(responses, "f", "Mailbox/get"));
      // A folder id that is not one of this account's folders matches nothing.
      if (!folder.list.some((f) => f.id === input.folder_id)) return null;
    }
    const query = methodResult(responses, "q", "Email/query");
    const ids = parseUpstream(z.array(z.string()), query.ids);
    const { list } = getResult(JmapEmailSummary, methodResult(responses, "g", "Email/get"));
    return { ids: ids.slice(0, count), byId: new Map(list.map((e) => [e.id, e])), more: ids.length > count };
  }

  async searchMail(input: SearchMailInputT): Promise<{ messages: MailSummary[]; next_offset: number | null }> {
    const { limit, offset } = input;
    if (input.has_attachment !== undefined) return this.#searchByAttachment(input, input.has_attachment);
    const page = await this.#summaries(input, offset, limit);
    if (page === null) return { messages: [], next_offset: null };
    const messages = page.ids.flatMap((id) => {
      const e = page.byId.get(id);
      return e ? [toSummary(e)] : [];
    });
    return { messages, next_offset: page.more ? offset + limit : null };
  }

  /**
   * The search with `has_attachment`: the server's flag is not the filter (`hasFile`), so the
   * other filters' results are looked through from `offset`, a page per request, until `limit`
   * messages match, the results end, or `attachmentScanMessages` were looked at. `next_offset`
   * is the position after the last message looked at, so a page can hold fewer messages than
   * `limit`, even none, and still have a next one.
   */
  async #searchByAttachment(
    input: SearchMailInputT,
    wanted: boolean,
  ): Promise<{ messages: MailSummary[]; next_offset: number | null }> {
    const messages: MailSummary[] = [];
    let position = input.offset;
    const end = input.offset + MAIL_LIMITS.attachmentScanMessages;
    while (position < end) {
      const page = await this.#summaries(input, position, MAIL_LIMITS.attachmentScanPage);
      if (page === null) return { messages: [], next_offset: null };
      for (const [i, id] of page.ids.entries()) {
        const e = page.byId.get(id);
        if (!e || hasFile(e) !== wanted) continue;
        messages.push(toSummary(e));
        if (messages.length < input.limit) continue;
        const more = page.more || i + 1 < page.ids.length;
        return { messages, next_offset: more ? position + i + 1 : null };
      }
      if (!page.more) return { messages, next_offset: null };
      position += page.ids.length;
    }
    return { messages, next_offset: position };
  }

  async readThread(input: ReadThreadInputT): Promise<{
    thread_id: string;
    messages: ThreadMessage[];
    omitted_messages: number;
  }> {
    const threadAnswer = await this.#call([["Thread/get", { ids: [input.thread_id] }, "t"]]);
    const threads = getResult(JmapThread, methodResult(threadAnswer, "t", "Thread/get", { idsFromInput: true }));
    const thread = threads.list.find((t) => t.id === input.thread_id);
    if (!thread || threads.notFound.includes(input.thread_id)) throw new MailError("not_found");

    // Thread/get lists emails oldest first: keep the newest ones, still oldest first.
    const newest = thread.emailIds.slice(-MAIL_LIMITS.threadMessagesMax);
    const emailAnswer = await this.#call([
      [
        "Email/get",
        {
          ids: newest,
          properties: THREAD_MESSAGE_PROPERTIES,
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
        },
        "e",
      ],
    ]);
    const { list } = getResult(JmapEmailFull, methodResult(emailAnswer, "e", "Email/get"));
    const byId = new Map(list.map((e) => [e.id, e]));
    const messages = newest.flatMap((id) => {
      const e = byId.get(id);
      return e ? [toThreadMessage(e)] : [];
    });
    return {
      thread_id: thread.id,
      messages,
      omitted_messages: thread.emailIds.length - newest.length,
    };
  }

  /**
   * One attachment of one message of this account. The message's attachments are looked up first:
   * a message that is not this account's, or that has no attachment with that part id, is
   * `not_found`. The blob id comes only from that answer, and the size the server reports is
   * checked before the download (and again while reading it). Then the bytes decide what is
   * delivered (`attachmentContent`).
   */
  async readAttachment(input: ReadAttachmentInputT): Promise<AttachmentDelivery> {
    // Checked before anything is asked, so a session that cannot download costs no request.
    if (usableDownloadUrl(this.#session.downloadUrl) === null) throw new MailError("mailbox_unsupported");
    const answer = await this.#call([
      ["Email/get", { ids: [input.message_id], properties: ["id", "attachments"], bodyProperties: ATTACHMENT_PART_PROPERTIES }, "a"],
    ]);
    const { list } = getResult(JmapEmailAttachments, methodResult(answer, "a", "Email/get", { idsFromInput: true }));
    const part = list.find((e) => e.id === input.message_id)?.attachments?.find((a) => a.partId === input.attachment_id);
    if (!part) throw new MailError("not_found");
    if (!MailIdSchema.safeParse(part.blobId).success) throw new MailError("upstream_rejected");
    if (part.size > MAIL_LIMITS.attachmentBytes) throw new MailError("too_large");

    const bytes = await downloadBlob(this.#session, this.#accessToken, this.#accountId, part.blobId!, MAIL_LIMITS.attachmentBytes);
    return {
      message_id: input.message_id,
      attachment_id: input.attachment_id,
      name: attachmentName(part.name),
      ...attachmentContent(bytes, { type: part.type, charset: part.charset ?? null }, input.offset, input.max_chars),
    };
  }

  /**
   * Looks up folders, the mailbox's own identity, the replied-to message and the messages whose
   * files are attached; uploads the other files; builds the Email. `input` is the message as the
   * vault prepared it (`prepareOutgoing`): the text part filled in, any HTML already sanitized and
   * the files decoded and checked.
   */
  async #prepare(input: PreparedMessage): Promise<Outgoing> {
    if (input.body === undefined) throw new MailError("invalid_input");
    // Checked before anything is asked, so a session that cannot upload costs no request.
    const attachments = input.attachments ?? [];
    if (attachments.some((a) => !isStored(a)) && usableUploadUrl(this.#session.uploadUrl) === null) {
      throw new MailError("mailbox_unsupported");
    }
    const calls: Call[] = [
      ["Mailbox/get", { ids: null, properties: ["id", "role"] }, "m"],
      ["Identity/get", { ids: null }, "i"],
    ];
    if (input.in_reply_to !== undefined) {
      calls.push(["Email/get", { ids: [input.in_reply_to], properties: ["id", "messageId", "references", "subject"] }, "r"]);
    }
    const sources = [...new Set(attachments.filter(isStored).map((a) => a.message_id))];
    if (sources.length > 0) {
      calls.push(["Email/get", { ids: sources, properties: ["id", "attachments"], bodyProperties: ATTACHMENT_PART_PROPERTIES }, "a"]);
    }
    const responses = await this.#call(calls);
    const folders = getResult(JmapMailboxRole, methodResult(responses, "m", "Mailbox/get")).list;
    const identities = getResult(JmapIdentity, methodResult(responses, "i", "Identity/get")).list;

    const own = this.#session.username.toLowerCase();
    const identity = identities.find((i) => i.email.toLowerCase() === own);
    if (!identity) throw new MailError("no_identity");
    const draftsId = folders.find((f) => f.role === "drafts")?.id;
    if (draftsId === undefined) throw new MailError("mailbox_unsupported");
    const sentId = folders.find((f) => f.role === "sent")?.id ?? null;

    let subject = input.subject ?? "";
    let threading: Record<string, string[]> = {};
    if (input.in_reply_to !== undefined) {
      const found = getResult(JmapReplySource, methodResult(responses, "r", "Email/get", { idsFromInput: true }));
      const original = found.list.find((e) => e.id === input.in_reply_to);
      if (!original) throw new MailError("not_found");
      threading = replyThreading(original);
      if (input.subject === undefined) subject = replySubject(original.subject);
    }

    const addresses = (list: string[]) => list.map((email) => ({ name: null, email }));
    const email: Record<string, unknown> = {
      mailboxIds: { [draftsId]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: identity.name ?? "", email: identity.email }],
      subject,
      ...threading,
      ...bodyOf(input.body, input.html),
    };
    if (input.to.length > 0) email.to = addresses(input.to);
    if (input.cc.length > 0) email.cc = addresses(input.cc);
    if (input.bcc.length > 0) email.bcc = addresses(input.bcc);
    if (attachments.length > 0) email.attachments = await this.#attachments(attachments, responses);
    return { email, identityId: identity.id, draftsId, sentId };
  }

  /**
   * The Email's `attachments`, in the order given. A stored file is looked up in the answer to
   * `Email/get` "a": a message that is not this account's, or that has no attachment with that part
   * id, is `not_found`; its blob is reused with its stored name (refused, `invalid_input`, when it
   * ends like a program) and its stored type when that is a plain media type. Then the total
   * (stored sizes as the server reports them, byte lengths of the rest) is checked
   * (`too_large`), and only then are the other files uploaded, one after the other.
   */
  async #attachments(attachments: PreparedAttachment[], responses: JmapInvocation[]): Promise<Record<string, unknown>[]> {
    const stored = attachments.some(isStored)
      ? getResult(JmapEmailAttachments, methodResult(responses, "a", "Email/get", { idsFromInput: true })).list
      : [];
    const resolve = (ref: StoredRef) => {
      const part = stored.find((e) => e.id === ref.message_id)?.attachments?.find((p) => p.partId === ref.attachment_id);
      if (!part) throw new MailError("not_found");
      if (!MailIdSchema.safeParse(part.blobId).success) throw new MailError("upstream_rejected");
      // A size that is not a whole number of bytes never enters the total.
      if (!Number.isSafeInteger(part.size) || part.size < 0) throw new MailError("upstream_rejected");
      const name = outgoingStoredName(part.name);
      const type = plainType(part.type) ?? "application/octet-stream";
      const charset = part.charset?.trim().toLowerCase() ?? "";
      const textCharset = type.startsWith("text/") && CHARSET_TOKEN.test(charset) ? charset : null;
      return { size: part.size, entry: attachmentPart(part.blobId!, type, name, textCharset) };
    };
    const resolved = attachments.map((a) => (isStored(a) ? resolve(a) : null));
    const total = attachments.reduce((n, a, i) => n + (isStored(a) ? resolved[i]!.size : a.bytes.length), 0);
    if (total > MAIL_LIMITS.attachmentsTotalBytes) throw new MailError("too_large");

    const parts: Record<string, unknown>[] = [];
    for (const [i, a] of attachments.entries()) {
      parts.push(isStored(a) ? resolved[i]!.entry : await this.#upload(a));
    }
    return parts;
  }

  /** Uploads one prepared file and answers its `attachments` entry. */
  async #upload(file: Upload): Promise<Record<string, unknown>> {
    const contentType = file.charset === null ? file.type : `${file.type}; charset=${file.charset}`;
    const blobId = await uploadBlob(this.#session, this.#accessToken, this.#accountId, file.bytes, contentType);
    return attachmentPart(blobId, file.type, file.name, file.charset);
  }

  async createDraft(input: PreparedMessage): Promise<{ draft_id: string; folder_id: string; attachments: number }> {
    const { email, draftsId } = await this.#prepare(input);
    const responses = await this.#call([["Email/set", { create: { draft: email } }, "d"]]);
    const draftId = createdId(methodResult(responses, "d", "Email/set"), "draft");
    if (draftId === null) throw new MailError("upstream_rejected");
    return { draft_id: draftId, folder_id: draftsId, attachments: input.attachments?.length ?? 0 };
  }

  /**
   * Moves messages into one folder of this account, named by id or by the Trash role. A moved
   * message is in that folder only. The patch is an `Email/set` update of `mailboxIds`: nothing
   * is destroyed, and an id that is not a message of this account is reported, not acted on.
   * A target named by id must not be the Trash folder.
   */
  async moveMail(input: MoveMailRequestT): Promise<MoveMailOutcome> {
    const { target } = input;
    const lookup = await this.#call([["Mailbox/get", { ids: null, properties: ["id", "role"] }, "m"]]);
    const folders = getResult(JmapMailboxRole, methodResult(lookup, "m", "Mailbox/get")).list;
    const folder =
      "role" in target ? folders.find((f) => f.role === target.role) : folders.find((f) => f.id === target.folder_id);
    if (!folder) throw new MailError("role" in target ? "mailbox_unsupported" : "not_found");
    // Moving into Trash is deleting. Only the request that names the role may do it, so the one
    // tool that is marked as deleting is the only way there.
    if (!("role" in target) && folder.role === "trash") throw new MailError("invalid_input");

    const { done, notDone } = await this.#updateEach(input.message_ids, { mailboxIds: { [folder.id]: true } });
    return { folder_id: folder.id, moved: done, not_moved: notDone };
  }

  /**
   * Sets or clears read (`$seen`) and flagged (`$flagged`) with an `Email/set` update of those two
   * keyword paths only: other keywords, the folders and the message itself stay as they are.
   */
  async markMail(input: MarkMailInputT): Promise<MarkMailOutcome> {
    const patch: Record<string, true | null> = {};
    if (input.read !== undefined) patch["keywords/$seen"] = input.read ? true : null;
    if (input.flagged !== undefined) patch["keywords/$flagged"] = input.flagged ? true : null;
    if (Object.keys(patch).length === 0) throw new MailError("invalid_input");
    const { done, notDone } = await this.#updateEach(input.message_ids, patch);
    return { marked: done, not_marked: notDone };
  }

  /**
   * One `Email/set` update applying `patch` to each message (duplicates once). An id that is not
   * a message of this account is reported, not acted on. When none was updated it throws:
   * `not_found` if the server knows none of them, else `upstream_rejected`.
   */
  async #updateEach(messageIds: string[], patch: Record<string, unknown>): Promise<{ done: number; notDone: string[] }> {
    const ids = [...new Set(messageIds)];
    const update = Object.fromEntries(ids.map((id) => [id, patch]));
    const responses = await this.#call([["Email/set", { update }, "u"]]);
    const { updated, refused } = updateResult(methodResult(responses, "u", "Email/set", { idsFromInput: true }));

    const notDone = ids.filter((id) => !updated.has(id));
    if (notDone.length === ids.length) {
      // Nothing changed. An id the answer does not mention counts as "no such message here"; any
      // other refusal is the server's and is reported as such.
      const unknownOnly = notDone.every((id) => (refused.get(id) ?? "notFound") === "notFound");
      throw new MailError(unknownOnly ? "not_found" : "upstream_rejected");
    }
    // Some changed: that is the result, and the rest is named, whatever the reason.
    return { done: ids.length - notDone.length, notDone };
  }

  /**
   * Sends in one request (`Email/set` + `EmailSubmission/set`). The lookups before it keep their
   * error mapping. For the submit request itself, an answer that does not show what Stalwart did
   * (no answer, 5xx, unreadable, method responses missing) is `send_unconfirmed`: the mail may
   * have gone out, so it must not be sent again blindly. A refusal Stalwart states is definite.
   */
  async sendMail(
    input: PreparedMessage,
  ): Promise<{ message_id: string; recipients: number; deduplicated: boolean; attachments: number }> {
    const { email, identityId, draftsId, sentId } = await this.#prepare(input);
    const afterSend: Record<string, unknown> =
      sentId === null
        ? { "keywords/$draft": null }
        : { [`mailboxIds/${draftsId}`]: null, [`mailboxIds/${sentId}`]: true, "keywords/$draft": null };
    const responses = await this.#call(
      [
        ["Email/set", { create: { draft: email } }, "d"],
        [
          "EmailSubmission/set",
          { create: { send: { identityId, emailId: "#draft" } }, onSuccessUpdateEmail: { "#send": afterSend } },
          "s",
        ],
      ],
      { outcomeUnknown: "send_unconfirmed" },
    );
    const answer = (callId: string, name: string) => responses.find((r) => r[2] === callId && (r[0] === name || r[0] === "error"));
    const draft = answer("d", "Email/set");
    const submission = answer("s", "EmailSubmission/set");
    if (!draft || !submission) throw new MailError("send_unconfirmed");

    const draftId = draft[0] === "error" ? null : createdId(draft[1], "draft");
    if (submission[0] === "error" || notCreated(submission[1], "send")) {
      // Refused by Stalwart. The draft, if created, stays where it is; nothing is ever destroyed.
      throw new MailError(draftId === null ? "upstream_rejected" : "send_failed");
    }
    // Neither created nor refused, or sent without a message id to report: we cannot tell.
    if (createdId(submission[1], "send") === null || draftId === null) throw new MailError("send_unconfirmed");
    return {
      message_id: draftId,
      recipients: input.to.length + input.cc.length + input.bcc.length,
      deduplicated: false,
      attachments: input.attachments?.length ?? 0,
    };
  }
}
