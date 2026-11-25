/**
 * The mailbox operations of one `MailboxVault`: each call is admitted against the mailbox's
 * limits, runs the JMAP adapter with the vault's access token and leaves as a plain
 * `VaultResult`. Sending is the one irreversible action: it is refused outside the recipient
 * allow-list, deduplicated, and counted against the daily limit before it goes out. A send whose
 * outcome is unknown stays counted and blocks an identical send for the dedupe window.
 */
import { type CollabAdapter, CollabRequest, type CollabValue } from "../collab";
import {
  CreateDraftInput,
  MAIL_LIMITS,
  MoveMailRequest,
  MailError,
  type MailErrorCode,
  ReadThreadInput,
  SearchMailInput,
  SendMailInput,
} from "../mail";
import type { z } from "zod";
import { clock } from "../clock";
import { type Area, parseFeatures } from "../config";
import type { Env } from "../env";
import type { JmapSession } from "../jmap/jmap-client";
import { JmapCollabAdapter } from "../jmap/jmap-collab-adapter";
import { JmapMailboxAdapter } from "../jmap/jmap-mailbox-adapter";
import { recipientsAllowed } from "../policy/environment";
import {
  confirmSend,
  dropSend,
  findRecentSend,
  markSendUnconfirmed,
  pruneRecentSends,
  type RecordedSend,
  reserveSend,
  sendFingerprint,
  takeToolCall,
} from "./limits";
import { readConnection } from "./token-store";

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

export class MailboxOperations {
  readonly #sql: SqlStorage;
  readonly #env: Env;
  readonly #withAccessToken: WithAccessToken;
  readonly #slots = new Slots(MAIL_LIMITS.upstreamConcurrency);
  /** Sends on their way upstream, by fingerprint: an identical send awaits the one in flight. */
  readonly #sendsInFlight = new Map<string, Promise<SendResult>>();

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
    return this.#operation("createDraft", caller, () => parse(CreateDraftInput, input), (draft) =>
      this.#upstream(caller.accountId, (a) => a.createDraft(draft)),
    );
  }

  moveMail(caller: Caller, input: unknown) {
    return this.#operation("moveMail", caller, () => parse(MoveMailRequest, input), (move) =>
      this.#upstream(caller.accountId, (a) => a.moveMail(move)),
    );
  }

  /**
   * The read-only contacts and calendar operations, as one request (`CollabRequest`). An area the
   * deployment has not switched on (`FEATURES`) is `not_granted`, whatever the stored token could do.
   */
  collab(caller: Caller, request: unknown): Promise<VaultResult<CollabValue>> {
    return this.#operation("collab", caller, () => {
      const parsed = parse(CollabRequest, request);
      const area: Area = parsed.op === "search_contacts" || parsed.op === "read_contact" ? "contacts" : "calendars";
      if (!(parseFeatures(this.#env.FEATURES) ?? new Set<Area>()).has(area)) throw new MailError("not_granted");
      return parsed;
    }, (req) =>
      this.#collabUpstream(caller.accountId, (a): Promise<CollabValue> => {
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
        }
      }),
    );
  }

  sendMail(caller: Caller, input: unknown): Promise<VaultResult<SendResult>> {
    const { accountId } = caller;
    return this.#operation("sendMail", caller, () => parse(SendMailInput, input), async (message) => {
      if (!recipientsAllowed(this.#env, [...message.to, ...message.cc, ...message.bcc])) {
        throw new MailError("recipient_not_allowed");
      }
      const fingerprint = await sendFingerprint(message);
      // From here to `set` nothing awaits, so no second identical send can slip in between.
      const inFlight = this.#sendsInFlight.get(fingerprint);
      if (inFlight) return { ...(await inFlight), deduplicated: true };
      const now = clock.now();
      pruneRecentSends(this.#sql, now);
      const recent = findRecentSend(this.#sql, fingerprint, now);
      if (recent?.state === "sent") return { ...recent.sent, deduplicated: true };
      // Unconfirmed, or pending with no twin in this instance (the object restarted mid-send).
      if (recent) throw new MailError("send_unconfirmed");
      const day = reserveSend(this.#sql, fingerprint, now);
      if (day === null) throw new MailError("send_limit_reached");

      const sending = this.#submit(accountId, message, fingerprint, day);
      this.#sendsInFlight.set(fingerprint, sending);
      try {
        return await sending;
      } finally {
        this.#sendsInFlight.delete(fingerprint);
      }
    });
  }

  /** The send itself, with its day reserved and its `pending` row written. */
  async #submit(
    accountId: string,
    message: z.output<typeof SendMailInput>,
    fingerprint: string,
    day: number,
  ): Promise<SendResult> {
    let sent: SendResult;
    try {
      sent = await this.#upstream(accountId, (a) => a.sendMail(message));
    } catch (e) {
      // A `MailError` other than `send_unconfirmed` is definite: Stalwart refused, or the request
      // never left (`withAccessToken` repeats the call only after a 401, when nothing was
      // processed). Anything else is not understood, so it is kept as unknown, like
      // `send_unconfirmed`: counted, and an identical send is refused for the dedupe window.
      if (e instanceof MailError && e.code !== "send_unconfirmed") dropSend(this.#sql, fingerprint, day);
      else markSendUnconfirmed(this.#sql, fingerprint);
      throw e;
    }
    confirmSend(this.#sql, fingerprint, sent);
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
  #collabUpstream<T>(accountId: string, call: (adapter: CollabAdapter) => Promise<T>): Promise<T> {
    return this.#slots.run(() =>
      this.#withAccessToken((accessToken, session) => call(new JmapCollabAdapter({ accountId, accessToken, session }))),
    );
  }
}
