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
 * leaves as `upstream_unavailable` and the caller decides whether to try again.
 */
import { z } from "zod";
import {
  type CalendarInfo,
  type CollabAdapter,
  type ContactDetail,
  type ContactSummary,
  type CreateContactInputT,
  type CreateEventInputT,
  type DeleteContactInputT,
  type DeleteEventInputT,
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
  EVENT_DETAIL_PROPERTIES,
  EVENT_SUMMARY_REQUEST,
  EVENT_TIME_ZONE,
  JmapAddressBook,
  JmapCalendar,
  JmapCalendarEvent,
  JmapContactCard,
  JmapTarget,
  newContactCard,
  toCalendarInfo,
  toContactDetail,
  toContactSummary,
  toEventDetail,
  toEventSummary,
} from "./collab-map";
import { jmapCall, methodResult, type JmapInvocation, type JmapSession } from "./jmap-client";
import { createdOrThrow, destroyResult, getResult, parseUpstream, requireUpdated } from "./map";

type Call = [name: string, args: Record<string, unknown>, callId: string];

export type CollabArea = "contacts" | "calendars";

const CORE = "urn:ietf:params:jmap:core";
const AREA_CAPABILITY: Record<CollabArea, string> = {
  contacts: "urn:ietf:params:jmap:contacts",
  calendars: "urn:ietf:params:jmap:calendars",
};

export class JmapCollabAdapter implements CollabAdapter {
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
  #call(area: CollabArea, calls: Call[], { write = false }: { write?: boolean } = {}): Promise<JmapInvocation[]> {
    return jmapCall(
      this.#session,
      this.#accessToken,
      calls.map(([name, args, callId]) => [name, { ...args, accountId: this.#accountId }, callId]),
      { using: [CORE, AREA_CAPABILITY[area]], ...(write ? { outcomeUnknown: "upstream_unavailable" as const } : {}) },
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
    options: { idsFromInput?: boolean } = {},
  ): Record<string, unknown> {
    const answer = responses.find((r) => r[2] === callId && (r[0] === name || r[0] === "error"));
    if (!answer || (answer[0] === "error" && answer[1].type === "serverFail")) throw new MailError("upstream_unavailable");
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
    return { event: toEventDetail(event) };
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

  // Part 2 implements the three event writes; until then they stop after the permission check.
  async createEvent(_input: CreateEventInputT): Promise<{ event_id: string; calendar_id: string }> {
    this.#require("calendars");
    throw new MailError("mailbox_unsupported");
  }

  async updateEvent(_input: UpdateEventInputT): Promise<{ event_id: string }> {
    this.#require("calendars");
    throw new MailError("mailbox_unsupported");
  }

  async deleteEvent(_input: DeleteEventInputT): Promise<{ deleted: number; not_deleted: string[] }> {
    this.#require("calendars");
    throw new MailError("mailbox_unsupported");
  }
}
