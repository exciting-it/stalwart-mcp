/**
 * The mailbox operations of one `MailboxVault`: each call is admitted against the mailbox's
 * limits, runs the JMAP adapter with the vault's access token and leaves as a plain
 * `VaultResult`. Sending is the one irreversible action: it is refused outside the recipient
 * allow-list, deduplicated, and counted against the daily limit before it goes out. A send whose
 * outcome is unknown stays counted and blocks an identical send for the dedupe window.
 *
 * An event write that makes the mail server notify people (invitations, updates, cancellations,
 * the answer to an invitation) is a send too: the same allow-list, the same daily counter (one
 * per notified event) and, for a create or update, the same dedupe. An answer is deduplicated
 * only while it is on its way or its outcome is unknown; the stored answer decides the rest. Whether it notifies is decided here (`event-notices.ts`); the
 * adapter only reads the event and writes with that decision.
 *
 * The event writes of one mailbox run one after the other (`#oneEventWriteAtATime`): an update
 * reads the event, decides and writes, and no other event write may change the event in between,
 * or a write decided as "notifies only allow-listed people" could notify someone else.
 */
import {
  type CollabUpstream,
  CollabRequest,
  type CollabValue,
  type CreateEventInputT,
  type CreateEventResultT,
  type DeleteEventInputT,
  type DeleteEventResultT,
  type DestroyOutcome,
  type RespondToEventInputT,
  type RespondToEventResultT,
  type UpdateEventInputT,
  type UpdateEventResultT,
} from "../collab";
import {
  CreateDraftInput,
  MAIL_LIMITS,
  MarkMailInput,
  MoveMailRequest,
  MailError,
  type MailErrorCode,
  type OutgoingMessage,
  ReadThreadInput,
  SearchMailInput,
  SendMailInput,
} from "../mail";
import type { z } from "zod";
import { clock } from "../clock";
import { cleanText, htmlToText } from "../content/sanitize";
import { sanitizeHtml } from "../content/sanitize-html";
import { type Area, enabledAreas } from "../config";
import type { Env } from "../env";
import type { JmapSession } from "../jmap/jmap-client";
import { JmapCollabAdapter } from "../jmap/jmap-collab-adapter";
import { JmapMailboxAdapter } from "../jmap/jmap-mailbox-adapter";
import { batchResult } from "../jmap/map";
import { recipientsAllowed } from "../policy/environment";
import { createNotice, deleteNotice, respondNotice, sendsFor, updateNotice } from "./event-notices";
import {
  confirmSend,
  dropSend,
  eventWriteFingerprint,
  findRecentSend,
  forgetSend,
  markSendUnconfirmed,
  pruneRecentSends,
  type RecordedSend,
  releaseSends,
  reserveSend,
  sendFingerprint,
  takeSends,
  takeToolCall,
} from "./limits";
import { readConnection } from "./token-store";

/** The area each operation of a `CollabRequest` belongs to. */
const COLLAB_OP_AREA: Record<z.output<typeof CollabRequest>["op"], Area> = {
  search_contacts: "contacts",
  read_contact: "contacts",
  create_contact: "contacts",
  update_contact: "contacts",
  delete_contact: "contacts",
  list_calendars: "calendars",
  search_events: "calendars",
  read_event: "calendars",
  create_event: "calendars",
  update_event: "calendars",
  delete_event: "calendars",
  respond_to_event: "calendars",
};

export type VaultResult<T> = { ok: true; value: T } | { ok: false; code: MailErrorCode };

export type SendResult = RecordedSend & { deduplicated: boolean };

/** The account id and address of the calling grant; both must match the stored connection. */
export interface Caller {
  accountId: string;
  email: string;
}

/** The vault's token door, handed in by the object; never reachable from outside it. */
export type WithAccessToken = <T>(fn: (token: string, session: JmapSession) => Promise<T>) => Promise<T>;

/** At most `size` tasks run at once; the others wait in arrival order. */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      // A waiting task takes the slot over directly.
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new MailError("invalid_input");
  return parsed.data;
}

/**
 * The message as it is sent or stored. Its HTML is sanitized here, in the vault, before the
 * fingerprint is taken and before the mailbox is touched. The text part is `body` when given,
 * otherwise the text of the sanitized HTML, cleaned as the reading side cleans mail text. HTML
 * with nothing visible left is refused without a `body` and left out with one. HTML the parser
 * cannot place is refused. Without HTML the message is returned as it is.
 */
async function prepareOutgoing(message: OutgoingMessage): Promise<OutgoingMessage & { body: string }> {
  const { html, ...rest } = message;
  if (html === undefined) {
    if (rest.body === undefined) throw new MailError("invalid_input");
    return { ...rest, body: rest.body };
  }
  const clean = await sanitizeHtml(html);
  if (clean === null) throw new MailError("invalid_input");
  const text = cleanText(htmlToText(clean), MAIL_LIMITS.htmlInputChars).text;
  const visible = text.trim() !== "";
  if (rest.body !== undefined) return visible ? { ...rest, body: rest.body, html: clean } : { ...rest, body: rest.body };
  if (!visible) throw new MailError("invalid_input");
  return { ...rest, body: text, html: clean };
}

export class MailboxOperations {
  readonly #sql: SqlStorage;
  readonly #env: Env;
  readonly #withAccessToken: WithAccessToken;
  readonly #slots = new Slots(MAIL_LIMITS.upstreamConcurrency);
  /** Sends (and notifying event writes) on their way upstream, by fingerprint: an identical one awaits it. */
  readonly #sendsInFlight = new Map<string, Promise<unknown>>();
  /** Answers to invitations from the moment they are queued until they are done, by fingerprint. */
  readonly #answersInFlight = new Map<string, Promise<RespondToEventResultT>>();
  /** Settles when the event write before the latest one is done: the tail of the event-write queue. */
  #eventWriteQueue: Promise<void> = Promise.resolve();

  constructor(opts: { sql: SqlStorage; env: Env; withAccessToken: WithAccessToken }) {
    this.#sql = opts.sql;
    this.#env = opts.env;
    this.#withAccessToken = opts.withAccessToken;
  }

  listMailboxes(caller: Caller) {
    return this.#operation("listMailboxes", caller, () => undefined, () =>
      this.#upstream(caller.accountId, (a) => a.listMailboxes()),
    );
  }

  searchMail(caller: Caller, input: unknown) {
    return this.#operation("searchMail", caller, () => parse(SearchMailInput, input), (query) =>
      this.#upstream(caller.accountId, (a) => a.searchMail(query)),
    );
  }

  readThread(caller: Caller, input: unknown) {
    return this.#operation("readThread", caller, () => parse(ReadThreadInput, input), (thread) =>
      this.#upstream(caller.accountId, (a) => a.readThread(thread)),
    );
  }

  createDraft(caller: Caller, input: unknown) {
    return this.#operation("createDraft", caller, () => parse(CreateDraftInput, input), async (draft) => {
      const prepared = await prepareOutgoing(draft);
      return this.#upstream(caller.accountId, (a) => a.createDraft(prepared));
    });
  }

  moveMail(caller: Caller, input: unknown) {
    return this.#operation("moveMail", caller, () => parse(MoveMailRequest, input), (move) =>
      this.#upstream(caller.accountId, (a) => a.moveMail(move)),
    );
  }

  markMail(caller: Caller, input: unknown) {
    return this.#operation("markMail", caller, () => parse(MarkMailInput, input), (mark) =>
      this.#upstream(caller.accountId, (a) => a.markMail(mark)),
    );
  }

  /**
   * The contacts and calendar operations, as one request (`CollabRequest`). An area the
   * deployment has switched off (`DISABLED_FEATURES`) is `not_granted`, whatever the stored token could do.
   */
  collab(caller: Caller, request: unknown): Promise<VaultResult<CollabValue>> {
    const { accountId } = caller;
    return this.#operation("collab", caller, () => {
      const parsed = parse(CollabRequest, request);
      const area: Area = COLLAB_OP_AREA[parsed.op];
      if (!(enabledAreas(this.#env.DISABLED_FEATURES) ?? new Set<Area>()).has(area)) throw new MailError("not_granted");
      return parsed;
    }, (req): Promise<CollabValue> => {
      switch (req.op) {
        case "create_event":
          return this.#sharedOrQueued("create_event", req.input, () => this.#createEvent(accountId, req.input));
        case "update_event":
          return this.#sharedOrQueued("update_event", req.input, () => this.#updateEvent(accountId, req.input));
        case "delete_event":
          return this.#oneEventWriteAtATime(() => this.#deleteEvent(accountId, req.input));
        case "respond_to_event":
          return this.#sharedAnswer(req.input, () => this.#respondToEvent(accountId, req.input));
      }
      return this.#collabUpstream(accountId, (a): Promise<CollabValue> => {
        switch (req.op) {
          case "search_contacts":
            return a.searchContacts(req.input);
          case "read_contact":
            return a.readContact(req.input);
          case "list_calendars":
            return a.listCalendars();
          case "search_events":
            return a.searchEvents(req.input);
          case "read_event":
            return a.readEvent(req.input);
          case "create_contact":
            return a.createContact(req.input);
          case "update_contact":
            return a.updateContact(req.input);
          case "delete_contact":
            return a.deleteContact(req.input);
        }
      });
    });
  }

  sendMail(caller: Caller, input: unknown): Promise<VaultResult<SendResult>> {
    const { accountId } = caller;
    return this.#operation("sendMail", caller, () => parse(SendMailInput, input), async (parsed) => {
      this.#requireAllowed([...parsed.to, ...parsed.cc, ...parsed.bcc]);
      const message = await prepareOutgoing(parsed);
      return this.#exactlyOnce<SendResult>(await sendFingerprint(message), 1, {
        send: () => this.#upstream(accountId, (a) => a.sendMail(message)),
        record: (sent) => ({ message_id: sent.message_id, recipients: sent.recipients }),
        again: (sent) => ({ ...sent, deduplicated: true }),
        recorded: (sent) => ({ ...sent, deduplicated: true }),
      });
    });
  }

  /**
   * Runs `task` once every event write queued before it is done (also when one of them failed),
   * and holds the next one back until `task` is done: read, decide and write of one event write
   * never interleave with another's.
   */
  async #oneEventWriteAtATime<T>(task: () => Promise<T>): Promise<T> {
    const before = this.#eventWriteQueue;
    let done!: () => void;
    this.#eventWriteQueue = new Promise<void>((resolve) => (done = resolve));
    try {
      await before;
      return await task();
    } finally {
      done();
    }
  }

  /**
   * A create or update identical to a notifying one on its way upstream shares that one's result,
   * marked `deduplicated`, as an identical send does; any other waits for its turn in the
   * event-write queue.
   */
  async #sharedOrQueued<T extends { deduplicated: boolean }>(
    op: "create_event" | "update_event",
    input: CreateEventInputT | UpdateEventInputT,
    task: () => Promise<T>,
  ): Promise<T> {
    const fingerprint = await eventWriteFingerprint(op, input);
    const inFlight = this.#sendsInFlight.get(fingerprint) as Promise<T> | undefined;
    if (inFlight) return { ...(await inFlight), deduplicated: true };
    return this.#oneEventWriteAtATime(task);
  }

  /** A notifying create is a send: allow-listed attendees only, counted, deduplicated. */
  async #createEvent(accountId: string, input: CreateEventInputT): Promise<CreateEventResultT> {
    const notice = createNotice(input, clock.now());
    if (!notice.notify) {
      const created = await this.#collabUpstream(accountId, (a) => a.createEvent(input, false));
      return { ...created, invitations: 0, deduplicated: false };
    }
    this.#requireAllowed(notice.addresses);
    const invitations = notice.addresses.length;
    return this.#exactlyOnce<CreateEventResultT>(await eventWriteFingerprint("create_event", input), sendsFor(notice), {
      send: async () => ({
        ...(await this.#collabUpstream(accountId, (a) => a.createEvent(input, true))),
        invitations,
        deduplicated: false,
      }),
      record: (r) => ({ message_id: `${r.event_id}/${r.calendar_id}`, recipients: r.invitations }),
      again: (r) => ({ ...r, deduplicated: true }),
      recorded: (sent) => {
        const [event_id = "", calendar_id = ""] = sent.message_id.split("/");
        return { event_id, calendar_id, invitations: sent.recipients, deduplicated: true };
      },
    });
  }

  /**
   * The event is read first: its attendees before the update, and when it ends. An update that
   * notifies is a send like a create; one that does not is passed on as it is. A meeting someone
   * else organized is only changed in the mailbox's own copy, never notifying, and its
   * participants and recurrence cannot be changed (`invalid_input`, nothing written).
   */
  async #updateEvent(accountId: string, input: UpdateEventInputT): Promise<UpdateEventResultT> {
    const audience = (await this.#collabUpstream(accountId, (a) => a.eventAudiences([input.event_id]))).get(input.event_id);
    if (audience === undefined) throw new MailError("not_found");
    if (!audience.organizedByMailbox && (input.participants !== undefined || input.recurrence !== undefined)) {
      throw new MailError("invalid_input");
    }
    const notice = updateNotice(input, audience, clock.now());
    if (!notice.notify) {
      const updated = await this.#collabUpstream(accountId, (a) => a.updateEvent(input, false, audience));
      return { ...updated, invitations: 0, deduplicated: false };
    }
    this.#requireAllowed(notice.addresses);
    const invitations = notice.addresses.length;
    return this.#exactlyOnce<UpdateEventResultT>(await eventWriteFingerprint("update_event", input), sendsFor(notice), {
      send: async () => ({
        ...(await this.#collabUpstream(accountId, (a) => a.updateEvent(input, true, audience))),
        invitations,
        deduplicated: false,
      }),
      record: (r) => ({ message_id: r.event_id, recipients: r.invitations }),
      again: (r) => ({ ...r, deduplicated: true }),
      recorded: (sent) => ({ event_id: sent.message_id, invitations: sent.recipients, deduplicated: true }),
    });
  }

  /**
   * An answer identical to one already queued or on its way shares that one's result, marked
   * `deduplicated`; any other waits for its turn in the event-write queue. It is shared from the
   * moment it is queued, because a later identical answer would otherwise find the first one's
   * answer stored and report a quiet no-op instead.
   */
  async #sharedAnswer(input: RespondToEventInputT, task: () => Promise<RespondToEventResultT>): Promise<RespondToEventResultT> {
    const fingerprint = await eventWriteFingerprint("respond_to_event", input);
    // From here to `set` nothing awaits, so no second identical answer can slip in between.
    const shared = this.#answersInFlight.get(fingerprint);
    if (shared) return { ...(await shared), deduplicated: true };
    const run = this.#oneEventWriteAtATime(task);
    this.#answersInFlight.set(fingerprint, run);
    try {
      return await run;
    } finally {
      this.#answersInFlight.delete(fingerprint);
    }
  }

  /**
   * An answer to an invitation: the event is read first. Only someone else's meeting that lists
   * the mailbox can be answered (`invalid_input` otherwise, nothing written). The stored answer
   * decides first: when it already equals the new one, nothing is written or sent, whatever the
   * dedupe rows say. One that notifies the organizer is a send: allow-listed organizer, one send
   * counted, and an unknown outcome blocks the identical answer for the window; a confirmed one
   * leaves no row (`forget`), so the same answer after a different one is a new send. One that
   * does not notify (the event ended) is written without scheduling messages.
   */
  async #respondToEvent(accountId: string, input: RespondToEventInputT): Promise<RespondToEventResultT> {
    const audience = (await this.#collabUpstream(accountId, (a) => a.eventAudiences([input.event_id]))).get(input.event_id);
    if (audience === undefined) throw new MailError("not_found");
    if (audience.organizedByMailbox || audience.self === null) throw new MailError("invalid_input");
    const answered = (organizer_notified: boolean, deduplicated: boolean): RespondToEventResultT => ({
      event_id: input.event_id,
      response: input.response,
      organizer_notified,
      deduplicated,
    });
    if (audience.self.status === input.response) return answered(false, false);
    const notice = respondNotice(audience, clock.now());
    if (!notice.notify) {
      await this.#collabUpstream(accountId, (a) => a.respondToEvent(input, false, audience));
      return answered(false, false);
    }
    this.#requireAllowed(notice.addresses);
    return this.#exactlyOnce<RespondToEventResultT>(await eventWriteFingerprint("respond_to_event", input), sendsFor(notice), {
      forget: true,
      send: async () => {
        await this.#collabUpstream(accountId, (a) => a.respondToEvent(input, true, audience));
        return answered(true, false);
      },
      // With `forget` no confirmed row is kept, so `record` and `recorded` are never used.
      record: (r) => ({ message_id: r.event_id, recipients: 1 }),
      again: (r) => ({ ...r, deduplicated: true }),
      recorded: (sent) => ({ ...answered(true, true), event_id: sent.message_id }),
    });
  }

  /**
   * The events are read first. Every event that notifies costs one send (one per started ten
   * addresses), reserved all at once before anything is deleted: when fewer are left, nothing is
   * deleted. Those events go in one `/set` with `sendSchedulingMessages: true`, the others in a
   * second one with `false`. Sends of events that were definitely not deleted are given back; after
   * an unknown outcome they stay. When the second request fails after the first went through, the
   * result still reports the first (its cancellations went out) and names the others as not
   * deleted. No dedupe: a repeated call finds nothing left to delete, so it notifies nobody.
   */
  async #deleteEvent(accountId: string, input: DeleteEventInputT): Promise<DeleteEventResultT> {
    const ids = [...new Set(input.event_ids)];
    const audiences = await this.#collabUpstream(accountId, (a) => a.eventAudiences(ids));
    const now = clock.now();
    const notices = new Map(ids.map((id) => [id, audiences.has(id) ? deleteNotice(audiences.get(id)!, now) : null]));
    const notifying = ids.filter((id) => notices.get(id)?.notify === true);
    const silent = ids.filter((id) => notices.get(id)?.notify !== true);
    const outcomes: DestroyOutcome[] = [];
    let cancelled: string[] = [];
    if (notifying.length > 0) {
      this.#requireAllowed(notifying.flatMap((id) => notices.get(id)!.addresses));
      const cost = (list: string[]) => list.reduce((n, id) => n + sendsFor(notices.get(id)!), 0);
      const day = takeSends(this.#sql, now, cost(notifying));
      if (day === null) throw new MailError("send_limit_reached");
      let outcome: DestroyOutcome;
      try {
        outcome = await this.#collabUpstream(accountId, (a) => a.deleteEvents(notifying, true));
      } catch (e) {
        // Definite (refused, or never sent): nothing went out. Otherwise it may have: kept.
        if (e instanceof MailError && e.code !== "send_unconfirmed") releaseSends(this.#sql, day, cost(notifying));
        throw e;
      }
      releaseSends(this.#sql, day, cost(outcome.notDeleted));
      cancelled = outcome.deleted;
      outcomes.push(outcome);
    }
    if (silent.length > 0) {
      try {
        outcomes.push(await this.#collabUpstream(accountId, (a) => a.deleteEvents(silent, false)));
      } catch (e) {
        // Nothing went out before: the error is the answer. Otherwise cancellations did, and the
        // result must say so; the silent events count as not deleted.
        if (outcomes.length === 0) throw e;
        outcomes.push({ deleted: [], notDeleted: silent, unknownOnly: false });
      }
    }
    return {
      ...batchResult(outcomes),
      cancellations: cancelled.length,
      cancelled_attendees: cancelled.reduce((n, id) => n + notices.get(id)!.addresses.length, 0),
    };
  }

  /** Outside production, every address a send or a notifying event write reaches must be allow-listed. */
  #requireAllowed(addresses: string[]): void {
    if (!recipientsAllowed(this.#env, addresses)) throw new MailError("recipient_not_allowed");
  }

  /**
   * Runs `send` at most once per fingerprint within the dedupe window, counted against the daily
   * send limit as `sends` sends. An identical call in flight awaits it (`again`); one already confirmed answers
   * from its row (`recorded`); one whose outcome is unknown is `send_unconfirmed`. With `forget`,
   * a confirmed send deletes its row instead of keeping it, so it never answers a later call.
   */
  async #exactlyOnce<T>(
    fingerprint: string,
    sends: number,
    o: {
      forget?: boolean;
      send: () => Promise<T>;
      record: (result: T) => RecordedSend;
      again: (result: T) => T;
      recorded: (sent: RecordedSend) => T;
    },
  ): Promise<T> {
    // From here to `set` nothing awaits, so no second identical send can slip in between.
    const inFlight = this.#sendsInFlight.get(fingerprint) as Promise<T> | undefined;
    if (inFlight) return o.again(await inFlight);
    const now = clock.now();
    pruneRecentSends(this.#sql, now);
    const recent = findRecentSend(this.#sql, fingerprint, now);
    if (recent?.state === "sent") return o.recorded(recent.sent);
    // Unconfirmed, or pending with no twin in this instance (the object restarted mid-send).
    if (recent) throw new MailError("send_unconfirmed");
    const day = reserveSend(this.#sql, fingerprint, now, sends);
    if (day === null) throw new MailError("send_limit_reached");

    const sending = this.#submit(fingerprint, day, sends, o.send, o.forget === true ? null : o.record);
    this.#sendsInFlight.set(fingerprint, sending);
    try {
      return await sending;
    } finally {
      this.#sendsInFlight.delete(fingerprint);
    }
  }

  /** The send itself, with its day reserved and its `pending` row written. */
  async #submit<T>(
    fingerprint: string,
    day: number,
    sends: number,
    send: () => Promise<T>,
    record: ((result: T) => RecordedSend) | null,
  ): Promise<T> {
    let sent: T;
    try {
      sent = await send();
    } catch (e) {
      // A `MailError` other than `send_unconfirmed` is definite: Stalwart refused, or the request
      // never left (`withAccessToken` repeats the call only after a 401, when nothing was
      // processed). Anything else is not understood, so it is kept as unknown, like
      // `send_unconfirmed`: counted, and an identical send is refused for the dedupe window.
      if (e instanceof MailError && e.code !== "send_unconfirmed") dropSend(this.#sql, fingerprint, day, sends);
      else markSendUnconfirmed(this.#sql, fingerprint);
      throw e;
    }
    if (record === null) forgetSend(this.#sql, fingerprint);
    else confirmSend(this.#sql, fingerprint, record(sent));
    return sent;
  }

  /** Drops recent-send rows older than the dedupe window (also run by the vault's alarm). */
  pruneRecentSends(): void {
    pruneRecentSends(this.#sql, clock.now());
  }

  /**
   * Admission in this order: a stored connection, the same account id and address (the address
   * case-insensitively), valid input, the tool-call limit. Then `act`. Failures leave as
   * `{ ok: false, code }` and never throw.
   */
  async #operation<I, T>(
    name: string,
    caller: Caller,
    validate: () => I,
    act: (input: I) => Promise<T>,
  ): Promise<VaultResult<T>> {
    try {
      const c = readConnection(this.#sql);
      if (!c) throw new MailError("reconnect_required");
      if (c.accountId !== caller.accountId || c.email.toLowerCase() !== caller.email.toLowerCase()) {
        throw new MailError("account_mismatch");
      }
      const input = validate();
      if (!takeToolCall(this.#sql, clock.now())) throw new MailError("rate_limited");
      return { ok: true, value: await act(input) };
    } catch (e) {
      if (e instanceof MailError) return { ok: false, code: e.code };
      console.error("vault_operation_failed", name);
      return { ok: false, code: "internal" };
    }
  }

  /** Waits for one of the upstream slots, then runs `call` with this mailbox's adapter. */
  #upstream<T>(accountId: string, call: (adapter: JmapMailboxAdapter) => Promise<T>): Promise<T> {
    return this.#slots.run(() =>
      this.#withAccessToken((accessToken, session) => call(new JmapMailboxAdapter({ accountId, accessToken, session }))),
    );
  }

  /** Like `#upstream`, with the contacts and calendar adapter. */
  #collabUpstream<T>(accountId: string, call: (adapter: CollabUpstream) => Promise<T>): Promise<T> {
    return this.#slots.run(() =>
      this.#withAccessToken((accessToken, session) => call(new JmapCollabAdapter({ accountId, accessToken, session }))),
    );
  }
}
