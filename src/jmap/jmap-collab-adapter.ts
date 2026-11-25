/**
 * `CollabAdapter` over JMAP for one mailbox: read-only contacts (RFC 9610) and calendars. Built
 * per call like `JmapMailboxAdapter`, with the mailbox's own access token and the account id
 * from the OAuth grant; every method call carries that account id. It sends `/get` and `/query`
 * methods only, never `/set`, `/copy` or `/parse`. A method starts by checking that the token's
 * scopes include its area; without them nothing is sent (`not_granted`).
 */
import { z } from "zod";
import {
  type CalendarInfo,
  type CollabAdapter,
  type ContactDetail,
  type ContactSummary,
  type EventDetail,
  type EventSummary,
  type ReadContactInputT,
  type ReadEventInputT,
  type SearchContactsInputT,
  type SearchEventsInputT,
} from "../collab";
import { MailError } from "../mail";
import {
  CALENDAR_PROPERTIES,
  CONTACT_DETAIL_PROPERTIES,
  CONTACT_SUMMARY_PROPERTIES,
  contactFilter,
  eventFilter,
  EVENT_DETAIL_PROPERTIES,
  EVENT_SUMMARY_REQUEST,
  EVENT_TIME_ZONE,
  JmapAddressBook,
  JmapCalendar,
  JmapCalendarEvent,
  JmapContactCard,
  toCalendarInfo,
  toContactDetail,
  toContactSummary,
  toEventDetail,
  toEventSummary,
} from "./collab-map";
import { jmapCall, methodResult, type JmapInvocation, type JmapSession } from "./jmap-client";
import { getResult, parseUpstream } from "./map";

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
  #call(area: CollabArea, calls: Call[]): Promise<JmapInvocation[]> {
    return jmapCall(
      this.#session,
      this.#accessToken,
      calls.map(([name, args, callId]) => [name, { ...args, accountId: this.#accountId }, callId]),
      { using: [CORE, AREA_CAPABILITY[area]] },
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
}
