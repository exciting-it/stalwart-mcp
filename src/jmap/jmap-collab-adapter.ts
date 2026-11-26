/**
 * `CollabAdapter` over JMAP for one mailbox: contacts (RFC 9610) and calendars, reading and
 * writing. Built per call like `JmapMailboxAdapter`, with the mailbox's own access token and the
 * account id from the OAuth grant; every method call carries that account id. It sends `/get` and
 * `/query`, and `/set` only for `ContactCard` and `CalendarEvent`: never `/copy`, `/parse` or a
 * `/set` of an address book or calendar. A method starts by checking that the token's scopes
 * include its area; without them nothing is sent (`not_granted`).
 *
 * A write is never repeated: the vault retries only after a 401 (the server refused the request
 * without processing it). Every write request is sent with `outcomeUnknown: "upstream_unavailable"`,
 * so a network error, timeout, 5xx or unreadable answer after which the server may have acted
 * leaves as `upstream_unavailable` and the caller decides whether to try again. An event write
 * that makes the server send mail (`notify`) leaves as `send_unconfirmed` instead, like a send.
 *
 * Event writes take the vault's decision `notify` and pass it on as `sendSchedulingMessages`:
 * whether the write may make the server send invitations, updates or cancellations. The vault
 * learns whom an existing event would notify from `eventAudiences`.
 */
import { z } from "zod";
import {
  type CalendarInfo,
  type CollabUpstream,
  type ContactDetail,
  type ContactSummary,
  type CreateContactInputT,
  type CreateEventInputT,
  type DeleteContactInputT,
  type DestroyOutcome,
  type EventAudience,
  type EventDetail,
  type EventSummary,
  type ReadContactInputT,
  type ReadEventInputT,
  type SearchContactsInputT,
  type SearchEventsInputT,
  type UpdateContactInputT,
  type UpdateEventInputT,
} from "../collab";
import { MailError } from "../mail";
import {
  CALENDAR_PROPERTIES,
  CONTACT_DETAIL_PROPERTIES,
  CONTACT_SUMMARY_PROPERTIES,
  chooseTarget,
  contactFilter,
  contactPatch,
  eventFilter,
  EVENT_AUDIENCE_PROPERTIES,
  EVENT_DETAIL_PROPERTIES,
  EVENT_RULE_PROPERTIES,
  EVENT_SUMMARY_REQUEST,
  EVENT_TIME_ZONE,
  type CalendarEventObject,
  JmapAddressBook,
  JmapCalendar,
  JmapCalendarEvent,
  JmapContactCard,
  JmapTarget,
  eventPatch,
  namesOwner,
  newCalendarEvent,
  newContactCard,
  seriesIdOf,
  toCalendarInfo,
  toContactDetail,
  toContactSummary,
  toEventDetail,
  toEventAudience,
  toEventSummary,
} from "./collab-map";
import { jmapCall, methodResult, type JmapInvocation, type JmapSession } from "./jmap-client";
import { createdOrThrow, destroyOutcome, destroyResult, getResult, parseUpstream, requireUpdated } from "./map";

type Call = [name: string, args: Record<string, unknown>, callId: string];

export type CollabArea = "contacts" | "calendars";

const CORE = "urn:ietf:params:jmap:core";
const AREA_CAPABILITY: Record<CollabArea, string> = {
  contacts: "urn:ietf:params:jmap:contacts",
  calendars: "urn:ietf:params:jmap:calendars",
};

/** What an unknown outcome of a write is: unavailable, or for a write that notifies people, an unconfirmed send. */
const unknownOutcome = (notify: boolean): "send_unconfirmed" | "upstream_unavailable" =>
  notify ? "send_unconfirmed" : "upstream_unavailable";

export class JmapCollabAdapter implements CollabUpstream {
  readonly #accountId: string;
  readonly #accessToken: string;
  readonly #session: JmapSession;

  constructor(opts: { accountId: string; accessToken: string; session: JmapSession }) {
    if (opts.session.accountId !== opts.accountId) throw new MailError("account_mismatch");
    this.#accountId = opts.accountId;
    this.#accessToken = opts.accessToken;
    this.#session = opts.session;
  }

  /** A connection whose token has no scope for `area` (connected before the area was switched on). */
  #require(area: CollabArea): void {
    if (!this.#session.capabilities.includes(AREA_CAPABILITY[area])) throw new MailError("not_granted");
  }

  /** The single exit to JMAP: the constructor's account id overrides anything in `args`. */
  #call(
    area: CollabArea,
    calls: Call[],
    { write = false, notify = false }: { write?: boolean; notify?: boolean } = {},
  ): Promise<JmapInvocation[]> {
    return jmapCall(
      this.#session,
      this.#accessToken,
      calls.map(([name, args, callId]) => [name, { ...args, accountId: this.#accountId }, callId]),
      { using: [CORE, AREA_CAPABILITY[area]], ...(write ? { outcomeUnknown: unknownOutcome(notify) } : {}) },
    );
  }

  /** `methodResult`, except that `unknownMethod` means the capability is not usable after all. */
  #result(
    responses: JmapInvocation[],
    callId: string,
    name: string,
    options: { idsFromInput?: boolean } = {},
  ): Record<string, unknown> {
    const answer = responses.find((r) => r[2] === callId && r[0] === "error");
    if (answer?.[1].type === "unknownMethod") throw new MailError("not_granted");
    return methodResult(responses, callId, name, options);
  }

  /**
   * The answer to a write's `/set`: like `#result`, except that no answer at all and a `serverFail`
   * are an unknown outcome (the write may have happened), so `upstream_unavailable`, not a refusal.
   */
  #writeResult(
    responses: JmapInvocation[],
    callId: string,
    name: string,
    options: { idsFromInput?: boolean; notify?: boolean } = {},
  ): Record<string, unknown> {
    const answer = responses.find((r) => r[2] === callId && (r[0] === name || r[0] === "error"));
    if (!answer || (answer[0] === "error" && answer[1].type === "serverFail")) {
      throw new MailError(unknownOutcome(options.notify === true));
    }
    return this.#result(responses, callId, name, options);
  }

  async searchContacts(
    input: SearchContactsInputT,
  ): Promise<{ contacts: ContactSummary[]; next_offset: number | null }> {
    this.#require("contacts");
    const { limit, offset } = input;
    // An address book id from the input is looked up in the same request: only a book that is
    // not this account's turns the query into an empty page.
    const bookCheck: Call[] =
      input.address_book_id === undefined
        ? []
        : [["AddressBook/get", { ids: [input.address_book_id], properties: ["id"] }, "b"]];
    const responses = await this.#call("contacts", [
      ...bookCheck,
      [
        "ContactCard/query",
        {
          filter: contactFilter(input),
          sort: [{ property: "updated", isAscending: false }],
          position: offset,
          limit: limit + 1,
        },
        "q",
      ],
      [
        "ContactCard/get",
        {
          "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" },
          properties: CONTACT_SUMMARY_PROPERTIES,
        },
        "g",
      ],
    ]);
    if (input.address_book_id !== undefined) {
      const books = getResult(JmapAddressBook, this.#result(responses, "b", "AddressBook/get"));
      if (!books.list.some((b) => b.id === input.address_book_id)) return { contacts: [], next_offset: null };
    }
    const query = this.#result(responses, "q", "ContactCard/query");
    const ids = parseUpstream(z.array(z.string()), query.ids);
    const { list } = getResult(JmapContactCard, this.#result(responses, "g", "ContactCard/get"));
    const byId = new Map(list.map((c) => [c.id, c]));
    const contacts = ids.slice(0, limit).flatMap((id) => {
      const card = byId.get(id);
      return card ? [toContactSummary(card)] : [];
    });
    return { contacts, next_offset: ids.length > limit ? offset + limit : null };
  }

  async readContact(input: ReadContactInputT): Promise<{ contact: ContactDetail }> {
    this.#require("contacts");
    const responses = await this.#call("contacts", [
      ["ContactCard/get", { ids: [input.contact_id], properties: CONTACT_DETAIL_PROPERTIES }, "g"],
    ]);
    const { list, notFound } = getResult(
      JmapContactCard,
      this.#result(responses, "g", "ContactCard/get", { idsFromInput: true }),
    );
    const card = list.find((c) => c.id === input.contact_id);
    if (!card || notFound.includes(input.contact_id)) throw new MailError("not_found");
    return { contact: toContactDetail(card) };
  }

  async listCalendars(): Promise<{ calendars: CalendarInfo[] }> {
    this.#require("calendars");
    const responses = await this.#call("calendars", [
      ["Calendar/get", { ids: null, properties: CALENDAR_PROPERTIES }, "c"],
    ]);
    const { list } = getResult(JmapCalendar, this.#result(responses, "c", "Calendar/get"));
    return { calendars: list.map(toCalendarInfo) };
  }

  async searchEvents(input: SearchEventsInputT): Promise<{ events: EventSummary[]; next_offset: number | null }> {
    this.#require("calendars");
    const { limit, offset } = input;
    // A calendar id from the input is looked up in the same request: only a calendar that is not
    // this account's turns the query into an empty page.
    const calendarCheck: Call[] =
      input.calendar_id === undefined
        ? []
        : [["Calendar/get", { ids: [input.calendar_id], properties: ["id"] }, "k"]];
    const responses = await this.#call("calendars", [
      ...calendarCheck,
      [
        "CalendarEvent/query",
        {
          filter: eventFilter(input),
          sort: [{ property: "start", isAscending: true }],
          expandRecurrences: true,
          timeZone: EVENT_TIME_ZONE,
          position: offset,
          limit: limit + 1,
        },
        "q",
      ],
      [
        "CalendarEvent/get",
        {
          "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" },
          properties: EVENT_SUMMARY_REQUEST,
          timeZone: EVENT_TIME_ZONE,
        },
        "g",
      ],
    ]);
    if (input.calendar_id !== undefined) {
      const calendars = getResult(JmapCalendar, this.#result(responses, "k", "Calendar/get"));
      if (!calendars.list.some((c) => c.id === input.calendar_id)) return { events: [], next_offset: null };
    }
    const query = this.#result(responses, "q", "CalendarEvent/query");
    const ids = parseUpstream(z.array(z.string()), query.ids);
    const { list } = getResult(JmapCalendarEvent, this.#result(responses, "g", "CalendarEvent/get"));
    const byId = new Map(list.map((e) => [e.id, e]));
    const events = ids.slice(0, limit).flatMap((id) => {
      const event = byId.get(id);
      return event ? [toEventSummary(event)] : [];
    });
    return { events, next_offset: ids.length > limit ? offset + limit : null };
  }

  async readEvent(input: ReadEventInputT): Promise<{ event: EventDetail }> {
    this.#require("calendars");
    const responses = await this.#call("calendars", [
      [
        "CalendarEvent/get",
        { ids: [input.event_id], properties: EVENT_DETAIL_PROPERTIES, timeZone: EVENT_TIME_ZONE },
        "g",
      ],
    ]);
    const { list, notFound } = getResult(
      JmapCalendarEvent,
      this.#result(responses, "g", "CalendarEvent/get", { idsFromInput: true }),
    );
    const event = list.find((e) => e.id === input.event_id);
    if (!event || notFound.includes(input.event_id)) throw new MailError("not_found");
    return { event: toEventDetail(event, await this.#seriesOf(event)) };
  }

  /**
   * The series an occurrence belongs to, read for its rule: the server shows one occurrence
   * without it. The id comes from the server's own answer for this account, never from the
   * input. Null for a stored event, and when the series is gone by now.
   */
  async #seriesOf(event: CalendarEventObject): Promise<CalendarEventObject | null> {
    const seriesId = seriesIdOf(event);
    if (seriesId === null) return null;
    const responses = await this.#call("calendars", [
      ["CalendarEvent/get", { ids: [seriesId], properties: EVENT_RULE_PROPERTIES }, "b"],
    ]);
    const { list } = getResult(JmapCalendarEvent, this.#result(responses, "b", "CalendarEvent/get"));
    return list.find((e) => e.id === seriesId) ?? null;
  }

  async createContact(input: CreateContactInputT): Promise<{ contact_id: string; address_book_id: string }> {
    this.#require("contacts");
    const books = await this.#call("contacts", [["AddressBook/get", { ids: null, properties: ["id", "isDefault"] }, "b"]]);
    const target = chooseTarget(getResult(JmapTarget, this.#result(books, "b", "AddressBook/get")).list, input.address_book_id);
    const responses = await this.#call(
      "contacts",
      [["ContactCard/set", { create: { c: newContactCard(input, target) } }, "s"]],
      { write: true },
    );
    const id = createdOrThrow(this.#writeResult(responses, "s", "ContactCard/set"), "c");
    return { contact_id: id, address_book_id: target };
  }

  async updateContact(input: UpdateContactInputT): Promise<{ contact_id: string }> {
    this.#require("contacts");
    const responses = await this.#call(
      "contacts",
      [["ContactCard/set", { update: { [input.contact_id]: contactPatch(input) } }, "s"]],
      { write: true },
    );
    requireUpdated(this.#writeResult(responses, "s", "ContactCard/set", { idsFromInput: true }), input.contact_id);
    return { contact_id: input.contact_id };
  }

  /** Permanent: JMAP has no trash for contacts. Duplicate ids count once; the others are named when refused. */
  async deleteContact(input: DeleteContactInputT): Promise<{ deleted: number; not_deleted: string[] }> {
    this.#require("contacts");
    const ids = [...new Set(input.contact_ids)];
    const responses = await this.#call("contacts", [["ContactCard/set", { destroy: ids }, "s"]], { write: true });
    return destroyResult(this.#writeResult(responses, "s", "ContactCard/set", { idsFromInput: true }), ids);
  }

  /**
   * Whom each event would notify and when it ends. An occurrence id answers for its event's
   * participants. Ids the server does not know (or of another account) are missing from the map.
   */
  async eventAudiences(ids: string[]): Promise<Map<string, EventAudience>> {
    this.#require("calendars");
    const unique = [...new Set(ids)];
    const responses = await this.#call("calendars", [
      ["CalendarEvent/get", { ids: unique, properties: EVENT_AUDIENCE_PROPERTIES, timeZone: EVENT_TIME_ZONE }, "a"],
    ]);
    const { list } = getResult(JmapCalendarEvent, this.#result(responses, "a", "CalendarEvent/get", { idsFromInput: true }));
    const audiences = new Map<string, EventAudience>();
    for (const event of list) if (unique.includes(event.id)) audiences.set(event.id, toEventAudience(event, this.#session.username));
    return audiences;
  }

  /**
   * The calendar is looked up first (as for contacts). With participants the mailbox is the
   * organizer; its own address as a participant is invalid input. `sendSchedulingMessages` is
   * always sent, `true` exactly when the vault decided this write notifies.
   */
  async createEvent(input: CreateEventInputT, notify: boolean): Promise<{ event_id: string; calendar_id: string }> {
    this.#require("calendars");
    const owner = this.#session.username;
    if (namesOwner(input.participants, owner)) throw new MailError("invalid_input");
    const calendars = await this.#call("calendars", [["Calendar/get", { ids: null, properties: ["id", "isDefault"] }, "c"]]);
    const target = chooseTarget(getResult(JmapTarget, this.#result(calendars, "c", "Calendar/get")).list, input.calendar_id);
    const responses = await this.#call(
      "calendars",
      [["CalendarEvent/set", { create: { e: newCalendarEvent(input, target, owner) }, sendSchedulingMessages: notify }, "s"]],
      { write: true, notify },
    );
    const set = this.#writeResult(responses, "s", "CalendarEvent/set", { notify });
    return { event_id: createdOrThrow(set, "e", unknownOutcome(notify)), calendar_id: target };
  }

  /**
   * A calendar id from the input is checked first: one that is not this account's is `not_found`.
   * `current` (the vault's read of the event) keeps its time zone and its attendees' answers.
   */
  async updateEvent(input: UpdateEventInputT, notify: boolean, current?: EventAudience): Promise<{ event_id: string }> {
    this.#require("calendars");
    const owner = this.#session.username;
    if (namesOwner(input.participants, owner)) throw new MailError("invalid_input");
    if (input.calendar_id !== undefined) {
      const calendars = await this.#call("calendars", [["Calendar/get", { ids: [input.calendar_id], properties: ["id"] }, "c"]]);
      chooseTarget(getResult(JmapTarget, this.#result(calendars, "c", "Calendar/get", { idsFromInput: true })).list, input.calendar_id);
    }
    const responses = await this.#call(
      "calendars",
      [["CalendarEvent/set", { update: { [input.event_id]: eventPatch(input, owner, current) }, sendSchedulingMessages: notify }, "s"]],
      { write: true, notify },
    );
    requireUpdated(this.#writeResult(responses, "s", "CalendarEvent/set", { idsFromInput: true, notify }), input.event_id, notify);
    return { event_id: input.event_id };
  }

  /** Permanent: one `/set` destroying `ids` (duplicates once). Reports, never throws, for ids that stayed. */
  async deleteEvents(ids: string[], notify: boolean): Promise<DestroyOutcome> {
    this.#require("calendars");
    const unique = [...new Set(ids)];
    const responses = await this.#call(
      "calendars",
      [["CalendarEvent/set", { destroy: unique, sendSchedulingMessages: notify }, "s"]],
      { write: true, notify },
    );
    return destroyOutcome(this.#writeResult(responses, "s", "CalendarEvent/set", { idsFromInput: true, notify }), unique, notify);
  }
}
