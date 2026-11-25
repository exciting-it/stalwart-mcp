/**
 * `MailboxAdapter` over JMAP for one mailbox. Built per call with that mailbox's own access
 * token and the account id from the OAuth grant; every method call carries that account id,
 * so the adapter cannot act on another account. It never destroys anything and never calls a
 * `/set` method other than `Email/set` create/update and `EmailSubmission/set` create.
 */
import {
  MAIL_LIMITS,
  MailError,
  type MailboxAdapter,
  type MailFolder,
  type MailSummary,
  type OutgoingMessage,
  type ReadThreadInputT,
  type SearchMailInputT,
  type ThreadMessage,
} from "../mail";
import { z } from "zod";
import { jmapCall, methodResult, type JmapInvocation, type JmapSession } from "./jmap-client";
import {
  createdId,
  getResult,
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
  SUMMARY_PROPERTIES,
  THREAD_MESSAGE_PROPERTIES,
  toFolder,
  toSummary,
  toThreadMessage,
} from "./map";

const MAX_BODY_VALUE_BYTES = 262_144;

type Call = [name: string, args: Record<string, unknown>, callId: string];

interface Outgoing {
  email: Record<string, unknown>;
  identityId: string;
  draftsId: string;
  sentId: string | null;
}

export class JmapMailboxAdapter implements MailboxAdapter {
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

  async searchMail(input: SearchMailInputT): Promise<{ messages: MailSummary[]; next_offset: number | null }> {
    const { limit, offset } = input;
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
          position: offset,
          limit: limit + 1,
        },
        "q",
      ],
      [
        "Email/get",
        { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: SUMMARY_PROPERTIES },
        "g",
      ],
    ]);
    if (input.folder_id !== undefined) {
      const folder = getResult(JmapMailboxRole, methodResult(responses, "f", "Mailbox/get"));
      // A folder id that is not one of this account's folders matches nothing.
      if (!folder.list.some((f) => f.id === input.folder_id)) return { messages: [], next_offset: null };
    }
    const query = methodResult(responses, "q", "Email/query");
    const ids = parseUpstream(z.array(z.string()), query.ids);
    const { list } = getResult(JmapEmailSummary, methodResult(responses, "g", "Email/get"));
    const byId = new Map(list.map((e) => [e.id, e]));
    const messages = ids
      .slice(0, limit)
      .flatMap((id) => {
        const e = byId.get(id);
        return e ? [toSummary(e)] : [];
      });
    return { messages, next_offset: ids.length > limit ? offset + limit : null };
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

  /** Looks up folders, the mailbox's own identity and the replied-to message; builds the Email. */
  async #prepare(input: OutgoingMessage): Promise<Outgoing> {
    const calls: Call[] = [
      ["Mailbox/get", { ids: null, properties: ["id", "role"] }, "m"],
      ["Identity/get", { ids: null }, "i"],
    ];
    if (input.in_reply_to !== undefined) {
      calls.push(["Email/get", { ids: [input.in_reply_to], properties: ["id", "messageId", "references", "subject"] }, "r"]);
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
      bodyValues: { body: { value: input.body } },
      textBody: [{ partId: "body", type: "text/plain" }],
    };
    if (input.to.length > 0) email.to = addresses(input.to);
    if (input.cc.length > 0) email.cc = addresses(input.cc);
    if (input.bcc.length > 0) email.bcc = addresses(input.bcc);
    return { email, identityId: identity.id, draftsId, sentId };
  }

  async createDraft(input: OutgoingMessage): Promise<{ draft_id: string; folder_id: string }> {
    const { email, draftsId } = await this.#prepare(input);
    const responses = await this.#call([["Email/set", { create: { draft: email } }, "d"]]);
    const draftId = createdId(methodResult(responses, "d", "Email/set"), "draft");
    if (draftId === null) throw new MailError("upstream_rejected");
    return { draft_id: draftId, folder_id: draftsId };
  }

  /**
   * Sends in one request (`Email/set` + `EmailSubmission/set`). The lookups before it keep their
   * error mapping. For the submit request itself, an answer that does not show what Stalwart did
   * (no answer, 5xx, unreadable, method responses missing) is `send_unconfirmed`: the mail may
   * have gone out, so it must not be sent again blindly. A refusal Stalwart states is definite.
   */
  async sendMail(input: OutgoingMessage): Promise<{ message_id: string; recipients: number; deduplicated: boolean }> {
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
    };
  }
}
