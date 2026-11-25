import { MailError } from "../src/mail";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLAB_LIMITS, type CollabAdapter } from "../src/collab";
import { fetchSession, jmapCall } from "../src/jmap/jmap-client";
import { chooseTarget } from "../src/jmap/collab-map";
import { JmapCollabAdapter } from "../src/jmap/jmap-collab-adapter";
import { createdOrThrow, destroyResult, requireUpdated } from "../src/jmap/map";
import { STALWART } from "../src/stalwart/endpoints";
import { createFakeStalwart, type FakeStalwart, type RecordedRequest } from "./fake-stalwart";

const A = "a@test.example";
const B = "b@test.example";
const CONTACTS = "urn:ietf:params:jmap:contacts";
const CALENDARS = "urn:ietf:params:jmap:calendars";
const CORE = "urn:ietf:params:jmap:core";

let fake: FakeStalwart;
const allRequests: RecordedRequest[] = [];
/** Requests of the tests that write: kept apart, so the read operations can be shown to send only reads. */
const writeRequests: RecordedRequest[] = [];
let writing = false;

beforeEach(() => {
  fake = createFakeStalwart();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  (writing ? writeRequests : allRequests).push(...fake.requests);
  vi.unstubAllGlobals();
});

async function adapterFor(email: string, options: { mailOnly?: boolean } = {}): Promise<JmapCollabAdapter & CollabAdapter> {
  const { accessToken } = fake.tokensFor(email, options);
  const session = await fetchSession(accessToken);
  return new JmapCollabAdapter({ accountId: session.accountId, accessToken, session });
}

const jmapRequests = () => fake.requests.filter((r) => r.url === `${STALWART.origin}/jmap/`);
const calls = (r: RecordedRequest): [string, Record<string, unknown>, string][] => r.body.methodCalls;
const methodNames = (r: RecordedRequest): string[] => calls(r).map((c) => c[0]);

async function expectMailError(p: Promise<unknown>, code: string): Promise<void> {
  const error = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MailError);
  expect(error).toMatchObject({ code });
}

const ADA = {
  kind: "individual",
  name: {
    full: "Ada Lovelace",
    components: [
      { kind: "given", value: "Ada" },
      { kind: "surname", value: "Lovelace" },
    ],
  },
  nicknames: { n1: { name: "Countess" } },
  emails: {
    e1: { address: "ada@example.org", contexts: { work: true } },
    e2: { address: "ada@home.example", label: "Home", contexts: { private: true } },
  },
  phones: { p1: { number: "+49 30 1234", contexts: { private: true } }, p2: { number: "+44 20 99" } },
  organizations: { o1: { name: "Analytical Engines", units: [{ name: "Research" }] } },
  titles: { t1: { name: "Programmer" } },
  addresses: {
    a1: { full: "1 Main Street, London", contexts: { work: true } },
    a2: { components: [{ kind: "name", value: "Elm Road" }, { kind: "separator", value: " " }, { kind: "locality", value: "Bath" }] },
  },
  notes: { n1: { note: "Likes engines" }, n2: { note: "Wrote the first program" } },
  anniversaries: { b1: { kind: "birth", date: { year: 1815, month: 12, day: 10 } } },
  updated: "2026-03-01T00:00:00Z",
};

describe("searchContacts", () => {
  it("maps a card to a summary and sends the documented request", async () => {
    const { accountId } = fake.addMailbox(A);
    const { id } = fake.addContact(A, ADA);
    const adapter = await adapterFor(A);

    expect(await adapter.searchContacts({ limit: 10, offset: 0 })).toEqual({
      contacts: [
        {
          id,
          name: "Ada Lovelace",
          emails: ["ada@example.org", "ada@home.example"],
          phones: ["+49 30 1234", "+44 20 99"],
          organization: "Analytical Engines",
          kind: "individual",
        },
      ],
      next_offset: null,
    });

    const [request] = jmapRequests();
    expect(request!.body.using).toEqual([CORE, CONTACTS]);
    expect(methodNames(request!)).toEqual(["ContactCard/query", "ContactCard/get"]);
    expect(calls(request!)).toEqual([
      [
        "ContactCard/query",
        { filter: {}, sort: [{ property: "updated", isAscending: false }], position: 0, limit: 11, accountId },
        "q",
      ],
      [
        "ContactCard/get",
        {
          "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" },
          properties: ["id", "kind", "name", "emails", "phones", "organizations"],
          accountId,
        },
        "g",
      ],
    ]);
  });

  it("passes each filter under its JMAP key and matches case-insensitively", async () => {
    fake.addMailbox(A);
    const ada = fake.addContact(A, ADA).id;
    fake.addContact(A, { name: { full: "Grace Hopper" }, emails: { e: { address: "grace@navy.example" } }, organizations: { o: { name: "Navy" } }, phones: { p: { number: "555-0101" } } });
    const adapter = await adapterFor(A);
    const ids = async (input: Parameters<JmapCollabAdapter["searchContacts"]>[0]) =>
      (await adapter.searchContacts(input)).contacts.map((c) => c.id);
    const base = { limit: 10, offset: 0 };

    expect(await ids({ ...base, name: "LOVELACE" })).toEqual([ada]);
    expect(await ids({ ...base, email: "home.example" })).toEqual([ada]);
    expect(await ids({ ...base, phone: "+44" })).toEqual([ada]);
    expect(await ids({ ...base, organization: "engines" })).toEqual([ada]);
    expect(await ids({ ...base, text: "countess" })).toEqual([ada]);
    expect(await ids({ ...base, name: "lovelace", email: "navy" })).toEqual([]);

    const filters = jmapRequests().map((r) => calls(r)[0]![1].filter);
    expect(filters).toEqual([
      { name: "LOVELACE" },
      { email: "home.example" },
      { phone: "+44" },
      { organization: "engines" },
      { text: "countess" },
      { name: "lovelace", email: "navy" },
    ]);
  });

  it("pages, newest change first, with limit + 1 and next_offset", async () => {
    fake.addMailbox(A);
    const ids = [1, 2, 3].map((n) => fake.addContact(A, { name: { full: `C${n}` }, updated: `2026-0${n}-01T00:00:00Z` }).id);
    const adapter = await adapterFor(A);

    const first = await adapter.searchContacts({ limit: 2, offset: 0 });
    expect(first.contacts.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(first.next_offset).toBe(2);
    const second = await adapter.searchContacts({ limit: 2, offset: 2 });
    expect(second.contacts.map((c) => c.id)).toEqual([ids[0]]);
    expect(second.next_offset).toBeNull();

    const [firstRequest, secondRequest] = jmapRequests();
    expect(calls(firstRequest!)[0]![1]).toMatchObject({ position: 0, limit: 3 });
    expect(calls(secondRequest!)[0]![1]).toMatchObject({ position: 2, limit: 3 });
  });

  it("restricts to an address book of this account and checks it in the same request", async () => {
    fake.addMailbox(A);
    const own = fake.addAddressBook(A, "Work").id;
    const inWork = fake.addContact(A, { name: { full: "In work" }, addressBookIds: { [own]: true } }).id;
    fake.addContact(A, { name: { full: "In default" } });
    const adapter = await adapterFor(A);

    expect((await adapter.searchContacts({ limit: 10, offset: 0, address_book_id: own })).contacts.map((c) => c.id)).toEqual([inWork]);
    const [request] = jmapRequests();
    expect(methodNames(request!)).toEqual(["AddressBook/get", "ContactCard/query", "ContactCard/get"]);
    expect(calls(request!)[0]![1]).toMatchObject({ ids: [own], properties: ["id"] });
    expect(calls(request!)[1]![1].filter).toEqual({ inAddressBook: own });
  });

  it("answers an empty page for an address book that is not this account's", async () => {
    fake.addMailbox(A);
    fake.addMailbox(B);
    fake.addContact(A, { name: { full: "Mine" } });
    const foreignBook = fake.addAddressBook(B, "Private").id;
    fake.addContact(B, { name: { full: "Theirs" }, addressBookIds: { [foreignBook]: true } });
    const adapter = await adapterFor(A);

    expect(await adapter.searchContacts({ limit: 10, offset: 0, address_book_id: foreignBook })).toEqual({ contacts: [], next_offset: null });
    expect(await adapter.searchContacts({ limit: 10, offset: 0, address_book_id: "ab99999" })).toEqual({ contacts: [], next_offset: null });
  });

  it("caps the lists of a summary and names a card by its fallbacks", async () => {
    fake.addMailbox(A);
    const emails = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`e${i}`, { address: `x${i}@example.org` }]));
    const phones = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, { number: `+1 555 000${i}` }]));
    fake.addContact(A, { name: { full: "Many" }, emails, phones, updated: "2026-01-09T00:00:00Z" });
    // No full name: the components in the order of the kinds, or as given when ordered.
    const parts = [
      { kind: "surname", value: "Doe" },
      { kind: "given", value: "Jane" },
      { kind: "title", value: "Dr" },
    ];
    fake.addContact(A, { name: { components: parts }, updated: "2026-01-08T00:00:00Z" });
    fake.addContact(A, { name: { isOrdered: true, components: parts }, updated: "2026-01-07T00:00:00Z" });
    fake.addContact(A, { organizations: { o: { name: "Only Org" } }, updated: "2026-01-06T00:00:00Z" });
    fake.addContact(A, { emails: { e: { address: "only@mail.example" } }, updated: "2026-01-05T00:00:00Z" });
    fake.addContact(A, { kind: "group", updated: "2026-01-04T00:00:00Z" });
    const adapter = await adapterFor(A);

    const { contacts } = await adapter.searchContacts({ limit: 10, offset: 0 });
    expect(contacts[0]!.emails).toHaveLength(COLLAB_LIMITS.summaryEmailsMax);
    expect(contacts[0]!.phones).toHaveLength(COLLAB_LIMITS.summaryPhonesMax);
    expect(contacts.slice(1).map((c) => c.name)).toEqual(["Dr Jane Doe", "Doe Jane Dr", "Only Org", "only@mail.example", ""]);
    expect(contacts[5]).toMatchObject({ kind: "group", organization: null });
  });

  it("strips control and bidi characters and caps single-line text", async () => {
    fake.addMailbox(A);
    fake.addContact(A, {
      name: { full: `Evil\u202eName\u0000\u200b${"x".repeat(500)}` },
      emails: { e: { address: "a\u202e@example.org" } },
      organizations: { o: { name: "Org\u2066 Inc" } },
    });
    const adapter = await adapterFor(A);
    const [contact] = (await adapter.searchContacts({ limit: 10, offset: 0 })).contacts;
    expect(contact!.name).toHaveLength(COLLAB_LIMITS.lineChars);
    expect(contact!.name.startsWith("EvilNamexxx")).toBe(true);
    expect(contact!.emails).toEqual(["a@example.org"]);
    expect(contact!.organization).toBe("Org Inc");
  });
});

describe("readContact", () => {
  it("maps the whole card", async () => {
    const { accountId } = fake.addMailbox(A);
    const book = fake.defaultAddressBookId(A);
    const { id } = fake.addContact(A, ADA);
    const adapter = await adapterFor(A);

    expect(await adapter.readContact({ contact_id: id })).toEqual({
      contact: {
        id,
        kind: "individual",
        name: "Ada Lovelace",
        given_name: "Ada",
        surname: "Lovelace",
        nicknames: ["Countess"],
        emails: [
          { address: "ada@example.org", label: "work" },
          { address: "ada@home.example", label: "Home" },
        ],
        phones: [
          { number: "+49 30 1234", label: "private" },
          { number: "+44 20 99", label: null },
        ],
        organizations: [{ name: "Analytical Engines", units: ["Research"] }],
        titles: ["Programmer"],
        addresses: [
          { text: "1 Main Street, London", label: "work" },
          { text: "Elm Road, Bath", label: null },
        ],
        birthday: "1815-12-10",
        notes: "Likes engines\n\nWrote the first program",
        notes_truncated: false,
        address_book_ids: [book],
        updated: "2026-03-01T00:00:00Z",
      },
    });

    const [request] = jmapRequests();
    expect(request!.body.using).toEqual([CORE, CONTACTS]);
    expect(calls(request!)).toEqual([
      [
        "ContactCard/get",
        {
          ids: [id],
          properties: [
            "id", "addressBookIds", "kind", "name", "nicknames", "emails", "phones", "organizations", "titles",
            "addresses", "notes", "anniversaries", "updated",
          ],
          accountId,
        },
        "g",
      ],
    ]);
  });

  it("formats a birthday without a year and one given as a UTC time, and defaults the kind", async () => {
    fake.addMailbox(A);
    const noYear = fake.addContact(A, { anniversaries: { b: { kind: "birth", date: { month: 3, day: 14 } } } }).id;
    const utc = fake.addContact(A, { anniversaries: { b: { kind: "birth", date: { utc: "1990-05-06T00:00:00Z" } } } }).id;
    const other = fake.addContact(A, { anniversaries: { b: { kind: "death", date: { year: 2000, month: 1, day: 1 } } } }).id;
    const adapter = await adapterFor(A);
    const detail = async (id: string) => (await adapter.readContact({ contact_id: id })).contact;
    expect((await detail(noYear)).birthday).toBe("--03-14");
    expect((await detail(utc)).birthday).toBe("1990-05-06");
    expect(await detail(other)).toMatchObject({ birthday: null, kind: "individual", updated: expect.any(String) });
  });

  it("caps a long note, the lists and the text, and drops control and bidi characters", async () => {
    fake.addMailbox(A);
    const emails = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`e${i}`, { address: `x${i}@example.org` }]));
    const { id } = fake.addContact(A, {
      name: { full: "Noted" },
      emails,
      notes: { n: { note: `start\u202e\u0000${"n".repeat(10_000)}` } },
      titles: { t: { name: "Boss\u2067" } },
    });
    const adapter = await adapterFor(A);
    const { contact } = await adapter.readContact({ contact_id: id });
    expect(contact.notes).toHaveLength(COLLAB_LIMITS.notesChars);
    expect(contact.notes.startsWith("startnnn")).toBe(true);
    expect(contact.notes_truncated).toBe(true);
    expect(contact.emails).toHaveLength(COLLAB_LIMITS.detailListMax);
    expect(contact.titles).toEqual(["Boss"]);
  });

  it("answers not_found for an id that does not exist", async () => {
    fake.addMailbox(A);
    const adapter = await adapterFor(A);
    await expectMailError(adapter.readContact({ contact_id: "ct999" }), "not_found");
  });
});

describe("isolation", () => {
  it("A's adapter cannot reach B's contact or address book, and no request carries B's account id", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const accountB = fake.addMailbox(B).accountId;
    fake.addContact(A, { name: { full: "Alice's friend" } });
    const secret = fake.addContact(B, { name: { full: "Bob's secret" }, emails: { e: { address: "secret@b.example" } } });
    const adapter = await adapterFor(A);

    await expectMailError(adapter.readContact({ contact_id: secret.id }), "not_found");
    const search = await adapter.searchContacts({ limit: 10, offset: 0, text: "secret" });
    expect(search.contacts).toEqual([]);
    const byBook = await adapter.searchContacts({ limit: 10, offset: 0, address_book_id: secret.addressBookId });
    expect(byBook.contacts).toEqual([]);
    expect(JSON.stringify([search, byBook])).not.toContain("Bob");

    const requests = jmapRequests();
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      for (const [, args] of calls(r)) {
        expect(args.accountId).toBe(accountA);
        expect(args.accountId).not.toBe(accountB);
      }
    }
  });

  it("refuses a session of another account", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const { accessToken } = fake.tokensFor(A);
    const session = await fetchSession(accessToken);
    expect(() => new JmapCollabAdapter({ accountId: `${accountA}x`, accessToken, session })).toThrow(MailError);
  });
});

describe("permission of a connection", () => {
  it("a token with the mail scope only answers not_granted for all five operations and sends no request", async () => {
    fake.addMailbox(A);
    const adapter = await adapterFor(A, { mailOnly: true });
    const before = fake.requests.length;
    const input = { limit: 10, offset: 0 };
    const range = { after: "2026-11-01T00:00:00Z", before: "2026-11-02T00:00:00Z", limit: 25, offset: 0 };
    await expectMailError(adapter.searchContacts(input), "not_granted");
    await expectMailError(adapter.readContact({ contact_id: "ct1" }), "not_granted");
    await expectMailError(adapter.listCalendars(), "not_granted");
    await expectMailError(adapter.searchEvents(range), "not_granted");
    await expectMailError(adapter.readEvent({ event_id: "ev1" }), "not_granted");
    expect(fake.requests.length).toBe(before);
  });

  it("the session lists an area only when the token's scopes include it", async () => {
    fake.addMailbox(A);
    const full = await fetchSession(fake.tokensFor(A).accessToken);
    expect(full.capabilities).toEqual(expect.arrayContaining([CONTACTS, CALENDARS]));
    const mail = await fetchSession(fake.tokensFor(A, { mailOnly: true }).accessToken);
    expect(mail.capabilities).toEqual(["urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"]);
  });

  it("an unknownMethod answer means not_granted after all", async () => {
    fake.addMailbox(A);
    const { id } = fake.addContact(A, { name: { full: "x" } });
    const adapter = await adapterFor(A);
    // The session was read while the token still had the scope.
    fake.restrictToMail(A);
    await expectMailError(adapter.searchContacts({ limit: 10, offset: 0 }), "not_granted");
    await expectMailError(adapter.readContact({ contact_id: id }), "not_granted");
  });
});

describe("the fake Stalwart's capability handling", () => {
  it("serves a method only when its capability is in `using`", async () => {
    fake.addMailbox(A);
    const { accessToken } = fake.tokensFor(A);
    const session = await fetchSession(accessToken);
    const args = { accountId: session.accountId, ids: null };
    const without = await jmapCall(session, accessToken, [["AddressBook/get", args, "x"]], { using: [CORE] });
    expect(without).toEqual([["error", { type: "unknownMethod" }, "x"]]);
    const withIt = await jmapCall(session, accessToken, [["AddressBook/get", args, "x"]], { using: [CORE, CONTACTS] });
    expect(withIt[0]![0]).toBe("AddressBook/get");
    // A mail method is unaffected by the contacts capability being listed, and needs the mail one.
    const mail = await jmapCall(session, accessToken, [["Mailbox/get", { accountId: session.accountId, ids: null }, "m"]]);
    expect(mail[0]![0]).toBe("Mailbox/get");
  });

  it("answers unknownMethod for an area the token lacks, and unsupportedFilter for an unknown filter key", async () => {
    fake.addMailbox(A);
    const full = fake.tokensFor(A).accessToken;
    const session = await fetchSession(full);
    const query = (filter: unknown): [string, Record<string, unknown>, string][] => [
      ["ContactCard/query", { accountId: session.accountId, filter }, "q"],
    ];
    const using = { using: [CORE, CONTACTS] };
    expect((await jmapCall(session, full, query({ nickname: "x" }), using))[0]).toEqual([
      "error",
      { type: "unsupportedFilter" },
      "q",
    ]);
    const mailOnly = fake.tokensFor(A, { mailOnly: true }).accessToken;
    expect((await jmapCall(session, mailOnly, query({}), using))[0]).toEqual(["error", { type: "unknownMethod" }, "q"]);
  });
});

// ---- calendars ----

const WINDOW = { after: "2026-11-27T00:00:00Z", before: "2026-11-28T00:00:00Z", limit: 25, offset: 0 };
type EventSearch = Parameters<JmapCollabAdapter["searchEvents"]>[0];
const search = (adapter: CollabAdapter, input: Partial<EventSearch> = {}) => adapter.searchEvents({ ...WINDOW, ...input });
const searchIds = async (adapter: CollabAdapter, input: Partial<EventSearch> = {}) =>
  (await search(adapter, input)).events.map((e) => e.id);

const EVENT_SUMMARY_REQUEST = [
  "id", "calendarIds", "title", "start", "timeZone", "duration", "showWithoutTime", "utcStart", "utcEnd",
  "status", "locations", "recurrenceId", "recurrenceRules",
];

describe("listCalendars", () => {
  it("maps the calendars and sends the documented request", async () => {
    const { accountId } = fake.addMailbox(A);
    const own = fake.defaultCalendarId(A);
    const shared = fake.addCalendar(A, "Holidays", { description: "Public holidays", color: "#ff0000", timeZone: "Europe/Berlin", readOnly: true });
    const adapter = await adapterFor(A);

    expect(await adapter.listCalendars()).toEqual({
      calendars: [
        { id: own, name: "Calendar", description: null, color: null, is_default: true, time_zone: null, can_write: true },
        { id: shared.id, name: "Holidays", description: "Public holidays", color: "#ff0000", is_default: false, time_zone: "Europe/Berlin", can_write: false },
      ],
    });
    const [request] = jmapRequests();
    expect(request!.body.using).toEqual([CORE, CALENDARS]);
    expect(calls(request!)).toEqual([
      [
        "Calendar/get",
        { ids: null, properties: ["id", "name", "description", "color", "isDefault", "timeZone", "myRights"], accountId },
        "c",
      ],
    ]);
  });

  it("sanitizes names and descriptions", async () => {
    fake.addMailbox(A);
    fake.addCalendar(A, `Work\u202e${"w".repeat(500)}`, { description: `d\u0000${"x".repeat(5000)}` });
    const adapter = await adapterFor(A);
    const { calendars } = await adapter.listCalendars();
    const work = calendars[1]!;
    expect(work.name).toHaveLength(COLLAB_LIMITS.lineChars);
    expect(work.name.startsWith("Workwww")).toBe(true);
    expect(work.description).toHaveLength(COLLAB_LIMITS.notesChars);
  });
});

describe("searchEvents", () => {
  it("maps an event to a summary, with UTC times from the server, and sends the documented request", async () => {
    const { accountId } = fake.addMailbox(A);
    const calendarId = fake.defaultCalendarId(A);
    const { id } = fake.addEvent(A, {
      title: "Planning",
      start: "2026-11-27T10:00:00",
      timeZone: "Europe/Berlin",
      duration: "PT90M",
      status: "confirmed",
      locations: { l1: { name: "Room 1" }, l2: { name: "Room 2" } },
    });
    const adapter = await adapterFor(A);

    expect(await search(adapter)).toEqual({
      events: [
        {
          id,
          calendar_ids: [calendarId],
          title: "Planning",
          start: "2026-11-27T09:00:00Z",
          end: "2026-11-27T10:30:00Z",
          local_start: "2026-11-27T10:00:00",
          time_zone: "Europe/Berlin",
          all_day: false,
          location: "Room 1",
          status: "confirmed",
          recurring: false,
        },
      ],
      next_offset: null,
    });

    const [request] = jmapRequests();
    expect(request!.body.using).toEqual([CORE, CALENDARS]);
    expect(methodNames(request!)).toEqual(["CalendarEvent/query", "CalendarEvent/get"]);
    expect(calls(request!)).toEqual([
      [
        "CalendarEvent/query",
        {
          filter: { after: "2026-11-27T00:00:00", before: "2026-11-28T00:00:00" },
          sort: [{ property: "start", isAscending: true }],
          expandRecurrences: true,
          timeZone: "Etc/UTC",
          position: 0,
          limit: 26,
          accountId,
        },
        "q",
      ],
      [
        "CalendarEvent/get",
        {
          "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" },
          properties: EVENT_SUMMARY_REQUEST,
          timeZone: "Etc/UTC",
          accountId,
        },
        "g",
      ],
    ]);
  });

  it("sends the bounds as LocalDateTime in UTC: converted from the offset, no offset and no Z", async () => {
    fake.addMailbox(A);
    const adapter = await adapterFor(A);
    await search(adapter, { after: "2026-11-27T10:30:00+02:00", before: "2026-11-27T23:45:30-05:00" });
    await search(adapter, { after: "2026-11-27T00:00:00.500Z", before: "2026-11-27T01:00:00Z" });
    const filters = jmapRequests().map((r) => calls(r)[0]![1].filter);
    expect(filters).toEqual([
      { after: "2026-11-27T08:30:00", before: "2026-11-28T04:45:30" },
      { after: "2026-11-27T00:00:00", before: "2026-11-27T01:00:00" },
    ]);
    // One condition with both bounds, never an operator tree: `expandRecurrences` needs that.
    for (const filter of filters) expect(Object.keys(filter as object)).toEqual(["after", "before"]);
  });

  it("converts a summer-time event correctly and shows all-day events", async () => {
    fake.addMailbox(A);
    const summer = fake.addEvent(A, { title: "Summer", start: "2026-07-01T10:00:00", timeZone: "Europe/Berlin" });
    const holiday = fake.addEvent(A, { title: "Holiday", start: "2026-07-01T00:00:00", duration: "P1D", showWithoutTime: true });
    const adapter = await adapterFor(A);
    const { events } = await search(adapter, { after: "2026-06-30T00:00:00Z", before: "2026-07-02T00:00:00Z" });
    expect(events.find((e) => e.id === summer.id)).toMatchObject({ start: "2026-07-01T08:00:00Z", end: "2026-07-01T09:00:00Z" });
    expect(events.find((e) => e.id === holiday.id)).toMatchObject({
      all_day: true,
      start: "2026-07-01T00:00:00Z",
      end: "2026-07-02T00:00:00Z",
      time_zone: null,
      location: null,
      status: null,
    });
  });

  it("returns events that overlap the window, earliest first, and not those that only touch it", async () => {
    fake.addMailbox(A);
    const crossing = fake.addEvent(A, { title: "Crossing", start: "2026-11-26T23:30:00" }).id;
    const early = fake.addEvent(A, { title: "Early", start: "2026-11-27T01:00:00" }).id;
    const late = fake.addEvent(A, { title: "Late", start: "2026-11-27T22:30:00", duration: "PT1H" }).id; // ends 23:30
    fake.addEvent(A, { title: "Ends at the start", start: "2026-11-26T23:00:00" });
    fake.addEvent(A, { title: "Starts at the end", start: "2026-11-28T00:00:00" });
    const adapter = await adapterFor(A);
    expect(await searchIds(adapter)).toEqual([crossing, early, late]);
  });

  it("passes calendar_id and text under their JMAP keys", async () => {
    fake.addMailbox(A);
    const work = fake.addCalendar(A, "Work").id;
    const inWork = fake.addEvent(A, { title: "Budget review", start: "2026-11-27T09:00:00", calendarIds: { [work]: true } }).id;
    fake.addEvent(A, { title: "Budget lunch", start: "2026-11-27T12:00:00" });
    const adapter = await adapterFor(A);

    expect(await searchIds(adapter, { calendar_id: work })).toEqual([inWork]);
    expect(await searchIds(adapter, { text: "REVIEW" })).toEqual([inWork]);
    expect(await searchIds(adapter, { calendar_id: work, text: "lunch" })).toEqual([]);
    const requests = jmapRequests();
    expect(methodNames(requests[0]!)).toEqual(["Calendar/get", "CalendarEvent/query", "CalendarEvent/get"]);
    expect(calls(requests[0]!)[0]![1]).toMatchObject({ ids: [work], properties: ["id"] });
    expect(calls(requests[0]!)[1]![1].filter).toEqual({ after: "2026-11-27T00:00:00", before: "2026-11-28T00:00:00", inCalendar: work });
    expect(calls(requests[1]!)[0]![1].filter).toEqual({ after: "2026-11-27T00:00:00", before: "2026-11-28T00:00:00", text: "REVIEW" });
  });

  it("pages with limit + 1 and next_offset", async () => {
    fake.addMailbox(A);
    const ids = [9, 10, 11].map((h) => fake.addEvent(A, { title: `E${h}`, start: `2026-11-27T${h}:00:00`.replace("T9", "T09") }).id);
    const adapter = await adapterFor(A);

    const first = await search(adapter, { limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual([ids[0], ids[1]]);
    expect(first.next_offset).toBe(2);
    const second = await search(adapter, { limit: 2, offset: 2 });
    expect(second.events.map((e) => e.id)).toEqual([ids[2]]);
    expect(second.next_offset).toBeNull();
    const [firstRequest, secondRequest] = jmapRequests();
    expect(calls(firstRequest!)[0]![1]).toMatchObject({ position: 0, limit: 3 });
    expect(calls(secondRequest!)[0]![1]).toMatchObject({ position: 2, limit: 3 });
  });

  it("answers an empty page for a calendar that is not this account's", async () => {
    fake.addMailbox(A);
    fake.addMailbox(B);
    fake.addEvent(A, { title: "Mine", start: "2026-11-27T09:00:00" });
    const foreign = fake.addCalendar(B, "Private").id;
    fake.addEvent(B, { title: "Theirs", start: "2026-11-27T09:00:00", calendarIds: { [foreign]: true } });
    const adapter = await adapterFor(A);
    expect(await search(adapter, { calendar_id: foreign })).toEqual({ events: [], next_offset: null });
    expect(await search(adapter, { calendar_id: "cal99999" })).toEqual({ events: [], next_offset: null });
  });

  it("yields one summary per occurrence in the window, each with its own id", async () => {
    fake.addMailbox(A);
    const daily = fake.addEvent(A, {
      title: "Standup",
      start: "2026-11-01T09:00:00",
      recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "daily", count: 5 }],
    }).id;
    const adapter = await adapterFor(A);
    const { events } = await search(adapter, { after: "2026-11-02T00:00:00Z", before: "2026-11-04T12:00:00Z" });
    expect(events.map((e) => e.id)).toEqual([`${daily}-20261102T090000`, `${daily}-20261103T090000`, `${daily}-20261104T090000`]);
    expect(events.map((e) => e.start)).toEqual(["2026-11-02T09:00:00Z", "2026-11-03T09:00:00Z", "2026-11-04T09:00:00Z"]);
    expect(events.map((e) => e.local_start)).toEqual(["2026-11-02T09:00:00", "2026-11-03T09:00:00", "2026-11-04T09:00:00"]);
    expect(events.every((e) => e.recurring && e.title === "Standup")).toBe(true);
    // The count of the rule ends the series: a window after the fifth occurrence finds nothing.
    expect(await searchIds(adapter, { after: "2026-11-06T00:00:00Z", before: "2026-11-30T00:00:00Z" })).toEqual([]);
    expect(await searchIds(adapter, { after: "2026-11-05T00:00:00Z", before: "2026-11-30T00:00:00Z" })).toEqual([`${daily}-20261105T090000`]);
  });

  it("expands a weekly rule with interval and until, and keeps single events single", async () => {
    fake.addMailbox(A);
    const weekly = fake.addEvent(A, {
      title: "Sync",
      start: "2026-11-02T09:00:00",
      recurrenceRules: [{ frequency: "weekly", interval: 2, until: "2026-12-01T00:00:00" }],
    }).id;
    const single = fake.addEvent(A, { title: "Once", start: "2026-11-10T09:00:00" }).id;
    const adapter = await adapterFor(A);
    const { events } = await search(adapter, { after: "2026-11-01T00:00:00Z", before: "2026-12-15T00:00:00Z" });
    expect(events.map((e) => e.id)).toEqual([
      `${weekly}-20261102T090000`,
      single,
      `${weekly}-20261116T090000`,
      `${weekly}-20261130T090000`,
    ]);
    expect(events.find((e) => e.id === single)!.recurring).toBe(false);
  });

  it("the fake answers like the server: expansion needs one condition with after and before", async () => {
    fake.addMailbox(A);
    const { accessToken } = fake.tokensFor(A);
    const session = await fetchSession(accessToken);
    const using = { using: [CORE, CALENDARS] };
    const query = (filter: unknown, extra: Record<string, unknown> = {}): [string, Record<string, unknown>, string][] => [
      ["CalendarEvent/query", { accountId: session.accountId, filter, expandRecurrences: true, ...extra }, "q"],
    ];
    const type = async (filter: unknown, extra?: Record<string, unknown>) =>
      (await jmapCall(session, accessToken, query(filter, extra), using))[0]![1].type;
    expect(await type({ after: "2026-11-01T00:00:00" })).toBe("invalidArguments");
    expect(await type({ before: "2026-11-01T00:00:00" })).toBe("invalidArguments");
    expect(await type(null)).toBe("invalidArguments");
    expect(await type({ operator: "AND", conditions: [{ after: "2026-11-01T00:00:00", before: "2026-11-02T00:00:00" }] })).toBe("invalidArguments");
    expect(await type({ after: "2026-11-01T00:00:00Z", before: "2026-11-02T00:00:00Z" })).toBe("invalidArguments");
    expect(await type({ after: "2026-11-01T00:00:00", before: "2026-11-02T00:00:00", inMailbox: "x" })).toBe("unsupportedFilter");
    const ok = await jmapCall(session, accessToken, query({ after: "2026-11-01T00:00:00", before: "2026-11-02T00:00:00" }), using);
    expect(ok[0]![0]).toBe("CalendarEvent/query");
  });

  it("strips control and bidi characters and caps single-line text", async () => {
    fake.addMailbox(A);
    fake.addEvent(A, {
      title: `Evil\u202eTitle\u0000\u200b${"x".repeat(500)}`,
      start: "2026-11-27T09:00:00",
      status: "con\u2066firmed",
      locations: { l: { name: "Room\u202e 1" } },
    });
    const adapter = await adapterFor(A);
    const [event] = (await search(adapter)).events;
    expect(event!.title).toHaveLength(COLLAB_LIMITS.lineChars);
    expect(event!.title.startsWith("EvilTitlexxx")).toBe(true);
    expect(event!.status).toBe("confirmed");
    expect(event!.location).toBe("Room 1");
  });
});

describe("readEvent", () => {
  const DETAILED = {
    title: "Project kickoff",
    description: "Agenda\r\n1. Scope",
    start: "2026-11-27T10:00:00",
    timeZone: "Europe/Berlin",
    duration: "PT1H",
    status: "confirmed",
    freeBusyStatus: "busy",
    privacy: "secret",
    locations: { l1: { name: "Room 1" }, l2: { name: "Annex" } },
    virtualLocations: { v1: { uri: "https://meet.example.org/abc", name: "Video" } },
    participants: {
      p1: { name: "Ada", email: "ada@example.org", roles: { attendee: true, chair: true }, participationStatus: "accepted" },
      p2: { name: "Bob", sendTo: { imip: "mailto:bob@example.org" }, roles: { optional: true }, participationStatus: "needs-action" },
      p3: { roles: { informational: true } },
    },
    recurrenceRules: [{ frequency: "weekly", interval: 2, until: "2027-01-01T00:00:00" }],
  };

  it("maps the whole event and sends the documented request", async () => {
    const { accountId } = fake.addMailbox(A);
    const calendarId = fake.defaultCalendarId(A);
    const { id } = fake.addEvent(A, DETAILED);
    const adapter = await adapterFor(A);

    expect(await adapter.readEvent({ event_id: id })).toEqual({
      event: {
        id,
        calendar_ids: [calendarId],
        title: "Project kickoff",
        start: "2026-11-27T09:00:00Z",
        end: "2026-11-27T10:00:00Z",
        local_start: "2026-11-27T10:00:00",
        time_zone: "Europe/Berlin",
        all_day: false,
        location: "Room 1",
        status: "confirmed",
        recurring: true,
        description: "Agenda\n1. Scope",
        description_truncated: false,
        locations: ["Room 1", "Annex"],
        online_meetings: ["https://meet.example.org/abc"],
        participants: [
          { name: "Ada", email: "ada@example.org", role: "chair", status: "accepted" },
          { name: "Bob", email: "bob@example.org", role: "optional", status: "needs-action" },
          { name: null, email: null, role: "informational", status: null },
        ],
        participants_omitted: 0,
        recurrence: "weekly, every 2, until 2027-01-01",
        free_busy: "busy",
        privacy: "secret",
      },
    });

    const [request] = jmapRequests();
    expect(request!.body.using).toEqual([CORE, CALENDARS]);
    const properties = [...EVENT_SUMMARY_REQUEST, "description", "descriptionContentType", "virtualLocations", "participants", "freeBusyStatus", "privacy"];
    expect(calls(request!)).toEqual([["CalendarEvent/get", { ids: [id], properties, timeZone: "Etc/UTC", accountId }, "g"]]);
    // utcStart together with recurrenceOverrides would be refused by the server.
    expect(properties).toContain("utcStart");
    expect(properties).not.toContain("recurrenceOverrides");
  });

  it("reads one occurrence of a recurring event by its id", async () => {
    fake.addMailbox(A);
    const series = fake.addEvent(A, {
      title: "Standup",
      start: "2026-11-01T09:00:00",
      recurrenceRules: [{ frequency: "daily", count: 5 }],
    }).id;
    const adapter = await adapterFor(A);
    const { events } = await search(adapter, { after: "2026-11-03T00:00:00Z", before: "2026-11-04T00:00:00Z" });
    const occurrenceId = events[0]!.id;
    expect(occurrenceId).toBe(`${series}-20261103T090000`);
    const { event } = await adapter.readEvent({ event_id: occurrenceId });
    expect(event).toMatchObject({
      id: occurrenceId,
      title: "Standup",
      start: "2026-11-03T09:00:00Z",
      local_start: "2026-11-03T09:00:00",
      recurring: true,
      recurrence: null,
    });
    await expectMailError(adapter.readEvent({ event_id: `${series}-20261109T090000` }), "not_found");
  });

  it("describes rules from their own fields only", async () => {
    fake.addMailbox(A);
    const a = fake.addEvent(A, { start: "2026-11-01T09:00:00", recurrenceRules: [{ frequency: "daily", count: 10 }] }).id;
    const b = fake.addEvent(A, { start: "2026-11-01T09:00:00", recurrenceRules: [{ frequency: "weekly", until: "2026-12-24T18:30:00" }, { frequency: "daily" }] }).id;
    const c = fake.addEvent(A, { start: "2026-11-01T09:00:00" }).id;
    const adapter = await adapterFor(A);
    const recurrence = async (id: string) => (await adapter.readEvent({ event_id: id })).event.recurrence;
    expect(await recurrence(a)).toBe("daily, 10 times");
    expect(await recurrence(b)).toBe("weekly, until 2026-12-24T18:30:00");
    expect(await recurrence(c)).toBeNull();
  });

  it("caps description, participants, locations and links, and drops unsafe links", async () => {
    fake.addMailbox(A);
    const participants = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, { name: `P${i}`, email: `p${i}@example.org` }]));
    const locations = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`l${i}`, { name: `Place ${i}` }]));
    const virtualLocations = {
      v0: { uri: "https://meet.example.org@evil.example/join" },
      v00: { uri: "https://user:pw@evil.example/join" },
      v1: { uri: "javascript:alert(1)" },
      v2: { uri: "https://one.example.org/a" },
      v3: { uri: "data:text/html,x" },
      v4: { uri: "http://two.example.org/b" },
      v5: { uri: "https://three.example.org/c" },
      v6: { uri: "https://four.example.org/d" },
      v7: { uri: "not a url" },
      v8: { uri: `https://long.example.org/${"a".repeat(2100)}` },
    };
    const { id } = fake.addEvent(A, {
      title: "Big",
      start: "2026-11-27T09:00:00",
      description: `start\u202e\u0000${"d".repeat(10_000)}`,
      participants,
      locations,
      virtualLocations,
    });
    const adapter = await adapterFor(A);
    const { event } = await adapter.readEvent({ event_id: id });
    expect(event.description).toHaveLength(COLLAB_LIMITS.descriptionChars);
    expect(event.description.startsWith("startddd")).toBe(true);
    expect(event.description_truncated).toBe(true);
    expect(event.participants).toHaveLength(COLLAB_LIMITS.participantsMax);
    expect(event.participants_omitted).toBe(10);
    expect(event.locations).toHaveLength(COLLAB_LIMITS.locationsMax);
    expect(event.online_meetings).toEqual(["https://one.example.org/a", "http://two.example.org/b", "https://three.example.org/c"]);
  });

  it("turns an HTML description into text", async () => {
    fake.addMailbox(A);
    const { id } = fake.addEvent(A, {
      start: "2026-11-27T09:00:00",
      description: "<p>Hello <b>team</b></p><script>alert(1)</script><p>Bring <a href=\"https://x.example.org/\">notes</a></p>",
      descriptionContentType: "text/html",
    });
    const plain = fake.addEvent(A, { start: "2026-11-27T09:00:00", description: "<p>kept as is</p>", descriptionContentType: "text/plain" }).id;
    const adapter = await adapterFor(A);
    const { event } = await adapter.readEvent({ event_id: id });
    expect(event.description).toContain("Hello team");
    expect(event.description).toContain("Bring notes");
    expect(event.description).toBe("Hello team\nBring notes <https://x.example.org/>");
    expect((await adapter.readEvent({ event_id: plain })).event.description).toBe("<p>kept as is</p>");
  });

  it("sanitizes participants and titles", async () => {
    fake.addMailbox(A);
    const { id } = fake.addEvent(A, {
      title: "T\u202ee",
      start: "2026-11-27T09:00:00",
      participants: { p: { name: "Mal\u0000lory\u2067", email: "m\u202e@example.org", participationStatus: "ac\u200bcepted" } },
    });
    const adapter = await adapterFor(A);
    const { event } = await adapter.readEvent({ event_id: id });
    expect(event.title).toBe("Te");
    expect(event.participants).toEqual([{ name: "Mallory", email: "m@example.org", role: null, status: "accepted" }]);
  });

  it("answers not_found for an id that does not exist", async () => {
    fake.addMailbox(A);
    const adapter = await adapterFor(A);
    await expectMailError(adapter.readEvent({ event_id: "ev999" }), "not_found");
  });

  it("the fake serves utcStart and utcEnd only when asked for, and refuses utcStart with recurrenceOverrides", async () => {
    fake.addMailbox(A);
    const { id } = fake.addEvent(A, { start: "2026-11-27T10:00:00", timeZone: "Europe/Berlin" });
    const { accessToken } = fake.tokensFor(A);
    const session = await fetchSession(accessToken);
    const get = async (properties: unknown) =>
      (await jmapCall(session, accessToken, [["CalendarEvent/get", { accountId: session.accountId, ids: [id], properties }, "g"]], { using: [CORE, CALENDARS] }))[0]!;
    const first = async (properties: unknown) => (await get(properties))[1].list as Record<string, unknown>[];
    expect((await first(null))[0]).not.toHaveProperty("utcStart");
    expect((await first(["id", "start"]))[0]).toEqual({ id, start: "2026-11-27T10:00:00" });
    expect((await first(["id", "utcStart", "utcEnd"]))[0]).toEqual({ id, utcStart: "2026-11-27T09:00:00Z", utcEnd: "2026-11-27T10:00:00Z" });
    expect(await get(["id", "utcStart", "recurrenceOverrides"])).toEqual(["error", { type: "invalidArguments" }, "g"]);
    expect((await get(["id", "recurrenceOverrides"]))[0]).toBe("CalendarEvent/get");
  });
});

describe("calendar isolation", () => {
  it("A's adapter cannot reach B's calendar or event, and no request carries B's account id", async () => {
    const accountA = fake.addMailbox(A).accountId;
    const accountB = fake.addMailbox(B).accountId;
    fake.addEvent(A, { title: "Alice's lunch", start: "2026-11-27T12:00:00" });
    const privateCalendar = fake.addCalendar(B, "Bob's private");
    const secret = fake.addEvent(B, { title: "Bob's secret", start: "2026-11-27T12:00:00", calendarIds: { [privateCalendar.id]: true } });
    const adapter = await adapterFor(A);

    await expectMailError(adapter.readEvent({ event_id: secret.id }), "not_found");
    const text = await search(adapter, { text: "secret" });
    const byCalendar = await search(adapter, { calendar_id: privateCalendar.id });
    expect(text.events).toEqual([]);
    expect(byCalendar.events).toEqual([]);
    const { calendars } = await adapter.listCalendars();
    expect(calendars.map((c) => c.id)).toEqual([fake.defaultCalendarId(A)]);
    expect(JSON.stringify([text, byCalendar, calendars])).not.toContain("Bob");

    const requests = jmapRequests();
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      for (const [, args] of calls(r)) {
        expect(args.accountId).toBe(accountA);
        expect(args.accountId).not.toBe(accountB);
      }
    }
  });
});

describe("calendar permission", () => {
  it("an unknownMethod answer means not_granted after all", async () => {
    fake.addMailbox(A);
    const { id } = fake.addEvent(A, { start: "2026-11-27T09:00:00" });
    const adapter = await adapterFor(A);
    // The session was read while the token still had the scope.
    fake.restrictToMail(A);
    await expectMailError(adapter.listCalendars(), "not_granted");
    await expectMailError(search(adapter), "not_granted");
    await expectMailError(search(adapter, { calendar_id: "cal1" }), "not_granted");
    await expectMailError(adapter.readEvent({ event_id: id }), "not_granted");
  });

  it("a token with the contacts scope but not the calendars scope gets not_granted for calendars only", async () => {
    fake.addMailbox(A);
    const { accessToken } = fake.tokensFor(A);
    const session = await fetchSession(accessToken);
    const adapter = new JmapCollabAdapter({
      accountId: session.accountId,
      accessToken,
      session: { ...session, capabilities: session.capabilities.filter((c) => c !== CALENDARS) },
    });
    const before = fake.requests.length;
    await expectMailError(adapter.listCalendars(), "not_granted");
    await expectMailError(search(adapter), "not_granted");
    await expectMailError(adapter.readEvent({ event_id: "ev1" }), "not_granted");
    expect(fake.requests.length).toBe(before);
    expect((await adapter.searchContacts({ limit: 1, offset: 0 })).contacts).toEqual([]);
  });

  it("answers upstream_rejected for an event shape it does not expect, without passing text on", async () => {
    fake.addMailbox(A);
    const { id } = fake.addEvent(A, { title: "Odd", start: "2026-11-27T09:00:00" });
    const adapter = await adapterFor(A);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fake.fetch(input, init);
      const body = (await response.clone().json()) as { methodResponses?: [string, { list?: Record<string, unknown>[] }][] };
      for (const [, args] of body.methodResponses ?? []) for (const e of args.list ?? []) e.recurrenceRules = "secret text";
      return Response.json(body);
    });
    await expectMailError(adapter.readEvent({ event_id: id }), "upstream_rejected");
    await expectMailError(search(adapter), "upstream_rejected");
  });
});

describe("the read operations", () => {
  // Runs before the write tests: every request the read tests sent is in `allRequests` by now.
  it("send only /get and /query: no request of the read tests above contains a /set, /copy or /parse method", () => {
    const names = allRequests.flatMap((r) =>
      Array.isArray(r.body?.methodCalls) ? (r.body.methodCalls as [string][]).map((c) => c[0]) : [],
    );
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => !/\/(get|query)$/.test(n))).toEqual([]);
  });
});

// ---- writing contacts ----

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const setCalls = (name: string) =>
  jmapRequests().flatMap((r) => calls(r).filter((c) => c[0] === name));

/** The fetch of the next `n`-th JMAP request is replaced by `answer`; all others reach the fake. */
function failRequest(nth: number, answer: () => Promise<Response>): void {
  let seen = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const isJmap = new Request(input, init).url === `${STALWART.origin}/jmap/`;
    if (isJmap && ++seen === nth) return answer();
    return fake.fetch(input, init);
  });
}

describe("writing contacts", () => {
  beforeAll(() => {
    writing = true;
  });
  afterAll(() => {
    writing = false;
  });

  describe("createContact", () => {
    it("looks up the address books, then creates a JSContact card in the default one", async () => {
      const { accountId } = fake.addMailbox(A);
      const work = fake.addAddressBook(A, "Work");
      const adapter = await adapterFor(A);
      const result = await adapter.createContact({
        name: "Ada Lovelace",
        given_name: "Ada",
        surname: "Lovelace",
        emails: [{ address: "ada@example.org", label: "work" }, { address: "ada@home.example" }],
        phones: [{ number: "+49 30 1234", label: "private" }],
        organization: "Analytical Engines",
        job_title: "Programmer",
        notes: "Line one\nLine two",
        birthday: "1815-12-10",
      });
      const book = fake.defaultAddressBookId(A);
      expect(book).not.toBe(work.id);
      expect(result).toEqual({ contact_id: expect.any(String), address_book_id: book });

      const requests = jmapRequests();
      expect(requests).toHaveLength(2);
      expect(requests[0]!.body.using).toEqual([CORE, CONTACTS]);
      expect(calls(requests[0]!)).toEqual([
        ["AddressBook/get", { ids: null, properties: ["id", "isDefault"], accountId }, "b"],
      ]);
      expect(requests[1]!.body.using).toEqual([CORE, CONTACTS]);
      expect(calls(requests[1]!)).toEqual([
        [
          "ContactCard/set",
          {
            accountId,
            create: {
              c: {
                "@type": "Card",
                version: "1.0",
                uid: expect.stringMatching(UUID),
                kind: "individual",
                addressBookIds: { [book]: true },
                name: {
                  full: "Ada Lovelace",
                  components: [
                    { kind: "given", value: "Ada" },
                    { kind: "surname", value: "Lovelace" },
                  ],
                  isOrdered: true,
                },
                emails: {
                  e1: { address: "ada@example.org", contexts: { work: true } },
                  e2: { address: "ada@home.example" },
                },
                phones: { p1: { number: "+49 30 1234", contexts: { private: true } } },
                organizations: { o1: { name: "Analytical Engines" } },
                titles: { t1: { name: "Programmer", kind: "title" } },
                notes: { n1: { note: "Line one\nLine two" } },
                anniversaries: { a1: { kind: "birth", date: { year: 1815, month: 12, day: 10 } } },
              },
            },
          },
          "s",
        ],
      ]);

      // Stored by the fake, and read back by the read adapter.
      const stored = fake.contactsOf(A);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: result.contact_id, uid: expect.stringMatching(UUID) });
      const { contact } = await adapter.readContact({ contact_id: result.contact_id });
      expect(contact).toMatchObject({
        name: "Ada Lovelace",
        given_name: "Ada",
        surname: "Lovelace",
        emails: [
          { address: "ada@example.org", label: "work" },
          { address: "ada@home.example", label: null },
        ],
        phones: [{ number: "+49 30 1234", label: "private" }],
        organizations: [{ name: "Analytical Engines", units: [] }],
        titles: ["Programmer"],
        notes: "Line one\nLine two",
        birthday: "1815-12-10",
        address_book_ids: [book],
      });
    });

    it("sends only the properties whose input was given, and a name built from the parts", async () => {
      fake.addMailbox(A);
      const adapter = await adapterFor(A);
      await adapter.createContact({ given_name: "Grace", surname: "Hopper", birthday: "--12-09" });
      await adapter.createContact({ organization: "Only Org", organization_ignored: undefined } as never);
      await adapter.createContact({ emails: [{ address: "only@example.org" }] });
      await adapter.createContact({ name: "Mononym", organization: "" });
      const created = setCalls("ContactCard/set").map(([, args]) => (args.create as { c: Record<string, unknown> }).c);
      expect(created[0]).toMatchObject({
        name: {
          full: "Grace Hopper",
          components: [
            { kind: "given", value: "Grace" },
            { kind: "surname", value: "Hopper" },
          ],
          isOrdered: true,
        },
        anniversaries: { a1: { kind: "birth", date: { month: 12, day: 9 } } },
      });
      expect(Object.keys(created[0]!).sort()).toEqual(
        ["@type", "addressBookIds", "anniversaries", "kind", "name", "uid", "version"],
      );
      expect((created[0]!.anniversaries as { a1: { date: object } }).a1.date).not.toHaveProperty("year");
      expect(Object.keys(created[1]!).sort()).toEqual(["@type", "addressBookIds", "kind", "organizations", "uid", "version"]);
      expect(Object.keys(created[2]!).sort()).toEqual(["@type", "addressBookIds", "emails", "kind", "uid", "version"]);
      expect(created[3]!.name).toEqual({ full: "Mononym" });
      expect(created[3]).not.toHaveProperty("organizations");
      expect(new Set(created.map((c) => c.uid)).size).toBe(4);
    });

    it("creates into the given address book of this account; one of another account is not_found", async () => {
      fake.addMailbox(A);
      fake.addMailbox(B);
      const mine = fake.addAddressBook(A, "Work");
      const theirs = fake.addAddressBook(B, "Bob's");
      const adapter = await adapterFor(A);
      const ok = await adapter.createContact({ name: "x", address_book_id: mine.id });
      expect(ok.address_book_id).toBe(mine.id);
      expect(fake.contactsOf(A)[0]!.addressBookIds).toEqual({ [mine.id]: true });
      const before = setCalls("ContactCard/set").length;
      await expectMailError(adapter.createContact({ name: "y", address_book_id: theirs.id }), "not_found");
      expect(setCalls("ContactCard/set")).toHaveLength(before);
      expect(fake.contactsOf(A)).toHaveLength(1);
      expect(fake.contactsOf(B)).toHaveLength(0);
    });

    it("answers upstream_unavailable, without trying again, when the outcome of the set is unknown", async () => {
      fake.addMailbox(A);
      const adapter = await adapterFor(A);
      for (const answer of [
        () => Promise.reject(new TypeError("network")),
        () => Promise.resolve(new Response("upstream detail", { status: 503 })),
        () => Promise.resolve(new Response("<html>upstream detail", { status: 200, headers: { "Content-Type": "application/json" } })),
        () => Promise.resolve(new Response(JSON.stringify({ methodResponses: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
      ]) {
        const before = fake.requests.length;
        failRequest(2, answer);
        await expectMailError(adapter.createContact({ name: "Once" }), "upstream_unavailable");
        // The address book lookup and one set: nothing was repeated.
        expect(fake.requests.length - before).toBe(1);
        vi.stubGlobal("fetch", fake.fetch);
      }
    });

    it("answers upstream_rejected when the server refuses the card, without passing text on", async () => {
      fake.addMailbox(A);
      const adapter = await adapterFor(A);
      failRequest(2, () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              methodResponses: [
                ["ContactCard/set", { accountId: "x", notCreated: { c: { type: "invalidProperties", description: "secret detail" } } }, "s"],
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );
      const error = await adapter.createContact({ name: "x" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "upstream_rejected" });
      expect(String((error as Error).message)).not.toContain("secret");
    });

    it("answers mailbox_unsupported when the account has no address book", async () => {
      fake.addMailbox(A);
      const adapter = await adapterFor(A);
      failRequest(1, () =>
        Promise.resolve(
          new Response(JSON.stringify({ methodResponses: [["AddressBook/get", { accountId: "x", list: [], notFound: [] }, "b"]] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      await expectMailError(adapter.createContact({ name: "x" }), "mailbox_unsupported");
    });
  });

  describe("updateContact", () => {
    it("patches one top-level key per given field and leaves the others as they are", async () => {
      const { accountId } = fake.addMailbox(A);
      const { id } = fake.addContact(A, ADA);
      const adapter = await adapterFor(A);
      const before = fake.contactsOf(A)[0]!;
      expect(await adapter.updateContact({ contact_id: id, job_title: "Mathematician", notes: "New note" })).toEqual({
        contact_id: id,
      });
      const requests = jmapRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.using).toEqual([CORE, CONTACTS]);
      expect(calls(requests[0]!)).toEqual([
        [
          "ContactCard/set",
          {
            accountId,
            update: { [id]: { titles: { t1: { name: "Mathematician", kind: "title" } }, notes: { n1: { note: "New note" } } } },
          },
          "s",
        ],
      ]);
      const after = fake.contactsOf(A)[0]!;
      expect(after.titles).toEqual({ t1: { name: "Mathematician", kind: "title" } });
      expect(after.notes).toEqual({ n1: { note: "New note" } });
      const { titles: _t, notes: _n, updated: _u, ...rest } = after;
      const { titles: _bt, notes: _bn, updated: _bu, ...restBefore } = before;
      expect(rest).toEqual(restBefore);
    });

    it("replaces a whole list; an empty list or text removes the property (null)", async () => {
      const { accountId } = fake.addMailbox(A);
      const { id } = fake.addContact(A, ADA);
      const adapter = await adapterFor(A);
      await adapter.updateContact({
        contact_id: id,
        emails: [{ address: "new@example.org", label: "private" }],
        phones: [],
        organization: "",
        job_title: "",
        notes: "",
        birthday: "--05-17",
      });
      expect(calls(jmapRequests()[0]!)[0]![1]).toEqual({
        accountId,
        update: {
          [id]: {
            emails: { e1: { address: "new@example.org", contexts: { private: true } } },
            phones: null,
            organizations: null,
            titles: null,
            notes: null,
            anniversaries: { a1: { kind: "birth", date: { month: 5, day: 17 } } },
          },
        },
      });
      const after = fake.contactsOf(A)[0]!;
      expect(after.emails).toEqual({ e1: { address: "new@example.org", contexts: { private: true } } });
      for (const gone of ["phones", "organizations", "titles", "notes"]) expect(after).not.toHaveProperty(gone);
      expect(after.name).toEqual(ADA.name);
    });

    it("rebuilds the name from the name parts that are given, and only then", async () => {
      fake.addMailbox(A);
      const { id } = fake.addContact(A, ADA);
      const adapter = await adapterFor(A);
      await adapter.updateContact({ contact_id: id, given_name: "Augusta" });
      expect(fake.contactsOf(A)[0]!.name).toEqual({
        full: "Augusta",
        components: [{ kind: "given", value: "Augusta" }],
        isOrdered: true,
      });
      await adapter.updateContact({ contact_id: id, name: "Countess of Lovelace" });
      expect(fake.contactsOf(A)[0]!.name).toEqual({ full: "Countess of Lovelace" });
      await adapter.updateContact({ contact_id: id, organization: "Elsewhere" });
      expect(fake.contactsOf(A)[0]!.name).toEqual({ full: "Countess of Lovelace" });
    });

    it("answers not_found for an unknown id and for another account's contact, which stays unchanged", async () => {
      fake.addMailbox(A);
      fake.addMailbox(B);
      const theirs = fake.addContact(B, { name: { full: "Bob" } });
      const adapter = await adapterFor(A);
      const before = fake.contactsOf(B);
      await expectMailError(adapter.updateContact({ contact_id: theirs.id, name: "Mine now" }), "not_found");
      await expectMailError(adapter.updateContact({ contact_id: "nope", name: "x" }), "not_found");
      expect(fake.contactsOf(B)).toEqual(before);
    });

    it("answers upstream_unavailable on a network error, where a read would pass the raw failure", async () => {
      fake.addMailbox(A);
      const { id } = fake.addContact(A, ADA);
      const adapter = await adapterFor(A);
      fake.failNext("network");
      await expectMailError(adapter.updateContact({ contact_id: id, name: "x" }), "upstream_unavailable");
      fake.failNext("invalid-json");
      await expectMailError(adapter.updateContact({ contact_id: id, name: "x" }), "upstream_unavailable");
    });
  });

  describe("deleteContact", () => {
    it("destroys the contact for good with one /set, and the card is gone", async () => {
      const { accountId } = fake.addMailbox(A);
      const { id } = fake.addContact(A, ADA);
      const keep = fake.addContact(A, { name: { full: "Keep" } });
      const adapter = await adapterFor(A);
      expect(await adapter.deleteContact({ contact_ids: [id] })).toEqual({ deleted: 1, not_deleted: [] });
      const requests = jmapRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.using).toEqual([CORE, CONTACTS]);
      expect(calls(requests[0]!)).toEqual([["ContactCard/set", { accountId, destroy: [id] }, "s"]]);
      expect(fake.contactsOf(A).map((c) => c.id)).toEqual([keep.id]);
      await expectMailError(adapter.readContact({ contact_id: id }), "not_found");
      await expectMailError(adapter.deleteContact({ contact_ids: [id] }), "not_found");
    });

    it("deletes a batch in one /set, counting duplicates once", async () => {
      const { accountId } = fake.addMailbox(A);
      const ids = [1, 2, 3, 4].map(() => fake.addContact(A, { name: { full: "x" } }).id);
      const adapter = await adapterFor(A);
      expect(await adapter.deleteContact({ contact_ids: [ids[0]!, ids[1]!, ids[0]!, ids[2]!] })).toEqual({
        deleted: 3,
        not_deleted: [],
      });
      expect(calls(jmapRequests()[0]!)).toEqual([["ContactCard/set", { accountId, destroy: [ids[0], ids[1], ids[2]] }, "s"]]);
      expect(jmapRequests()).toHaveLength(1);
      expect(fake.contactsOf(A).map((c) => c.id)).toEqual([ids[3]]);
    });

    it("deletes the others of a batch and names an unknown or foreign id; B's contact stays", async () => {
      fake.addMailbox(A);
      fake.addMailbox(B);
      const mine = fake.addContact(A, { name: { full: "Ann" } });
      const keep = fake.addContact(A, { name: { full: "Keep" } });
      const theirs = fake.addContact(B, { name: { full: "Bob" } });
      const adapter = await adapterFor(A);
      expect(await adapter.deleteContact({ contact_ids: [mine.id, theirs.id, "nope"] })).toEqual({
        deleted: 1,
        not_deleted: [theirs.id, "nope"],
      });
      expect(fake.contactsOf(A).map((c) => c.id)).toEqual([keep.id]);
      expect(fake.contactsOf(B)).toHaveLength(1);
    });

    it("answers not_found for another account's contact, which stays", async () => {
      fake.addMailbox(A);
      fake.addMailbox(B);
      const theirs = fake.addContact(B, { name: { full: "Bob" } });
      const adapter = await adapterFor(A);
      await expectMailError(adapter.deleteContact({ contact_ids: [theirs.id] }), "not_found");
      expect(fake.contactsOf(B)).toHaveLength(1);
    });
  });

  describe("round trip", () => {
    it("create, read, update (only the given fields change), search, delete, read is not_found", async () => {
      fake.addMailbox(A);
      const adapter = await adapterFor(A);
      const { contact_id } = await adapter.createContact({
        given_name: "Alan",
        surname: "Turing",
        emails: [{ address: "alan@example.org" }],
        organization: "Bletchley",
      });
      const found = await adapter.searchContacts({ limit: 10, offset: 0, text: "turing" });
      expect(found.contacts).toMatchObject([{ id: contact_id, name: "Alan Turing", emails: ["alan@example.org"], organization: "Bletchley" }]);
      const first = (await adapter.readContact({ contact_id })).contact;
      await adapter.updateContact({ contact_id, phones: [{ number: "+44 1" }] });
      const second = (await adapter.readContact({ contact_id })).contact;
      expect(second.phones).toEqual([{ number: "+44 1", label: null }]);
      expect({ ...second, phones: [], updated: null }).toEqual({ ...first, phones: [], updated: null });
      await adapter.deleteContact({ contact_ids: [contact_id] });
      await expectMailError(adapter.readContact({ contact_id }), "not_found");
      expect((await adapter.searchContacts({ limit: 10, offset: 0 })).contacts).toEqual([]);
    });
  });

  describe("isolation", () => {
    it("no write request carries B's account id, and B's address book and contacts stay untouched", async () => {
      const accountA = fake.addMailbox(A).accountId;
      const accountB = fake.addMailbox(B).accountId;
      const secret = fake.addContact(B, { name: { full: "Bob" } });
      const theirBook = fake.addAddressBook(B, "Bob's");
      const before = fake.contactsOf(B);
      const adapter = await adapterFor(A);
      await expectMailError(adapter.updateContact({ contact_id: secret.id, name: "x" }), "not_found");
      await expectMailError(adapter.deleteContact({ contact_ids: [secret.id] }), "not_found");
      await expectMailError(adapter.createContact({ name: "x", address_book_id: theirBook.id }), "not_found");
      await adapter.createContact({ name: "mine" });
      expect(fake.contactsOf(B)).toEqual(before);
      expect(fake.contactsOf(A)).toHaveLength(1);
      for (const r of jmapRequests()) {
        for (const [, args] of calls(r)) {
          expect(args.accountId).toBe(accountA);
          expect(args.accountId).not.toBe(accountB);
        }
      }
    });

    it("a card or patch the input tries to point at another account's id is sent with A's account id", async () => {
      const accountA = fake.addMailbox(A).accountId;
      fake.addMailbox(B);
      const adapter = await adapterFor(A);
      const sneaky = { name: "x", accountId: "acc-b", account_id: "acc-b" } as never;
      await adapter.createContact(sneaky).catch(() => undefined);
      expect(jmapRequests().flatMap((r) => calls(r)).every(([, a]) => a.accountId === accountA)).toBe(true);
      const card = (setCalls("ContactCard/set")[0]![1].create as { c: Record<string, unknown> }).c;
      expect(card).not.toHaveProperty("accountId");
      expect(card).not.toHaveProperty("account_id");
    });
  });

  describe("permission", () => {
    it("a token with the mail scope only answers not_granted for all six write operations and sends no request", async () => {
      fake.addMailbox(A);
      const adapter = await adapterFor(A, { mailOnly: true });
      const before = fake.requests.length;
      await expectMailError(adapter.createContact({ name: "x" }), "not_granted");
      await expectMailError(adapter.updateContact({ contact_id: "ct1", name: "x" }), "not_granted");
      await expectMailError(adapter.deleteContact({ contact_ids: ["ct1"] }), "not_granted");
      await expectMailError(adapter.createEvent({ title: "x", date: "2026-11-27" }), "not_granted");
      await expectMailError(adapter.updateEvent({ event_id: "ev1", title: "x" }), "not_granted");
      await expectMailError(adapter.deleteEvent({ event_ids: ["ev1"] }), "not_granted");
      expect(fake.requests.length).toBe(before);
    });

    it("an unknownMethod answer to a write means not_granted after all", async () => {
      fake.addMailbox(A);
      const { id } = fake.addContact(A, { name: { full: "x" } });
      const adapter = await adapterFor(A);
      fake.restrictToMail(A);
      await expectMailError(adapter.updateContact({ contact_id: id, name: "y" }), "not_granted");
      await expectMailError(adapter.deleteContact({ contact_ids: [id] }), "not_granted");
      await expectMailError(adapter.createContact({ name: "y" }), "not_granted");
    });
  });

  describe("the fake Stalwart's /set", () => {
    const setCall = async (args: Record<string, unknown>) => {
      const { accessToken } = fake.tokensFor(A);
      const session = await fetchSession(accessToken);
      const [answer] = await jmapCall(
        session,
        accessToken,
        [["ContactCard/set", { accountId: session.accountId, ...args }, "s"]],
        { using: [CORE, CONTACTS] },
      );
      return { answer: answer![1], session };
    };
    const card = (book: string, extra: Record<string, unknown> = {}) => ({
      "@type": "Card",
      version: "1.0",
      uid: "u1",
      addressBookIds: { [book]: true },
      ...extra,
    });

    it("refuses a card without @type, version, uid or an address book of this account, and unknown properties", async () => {
      fake.addMailbox(A);
      fake.addMailbox(B);
      const book = fake.defaultAddressBookId(A);
      const { answer } = await setCall({
        create: {
          noType: { ...card(book), "@type": undefined },
          noVersion: { ...card(book), version: undefined },
          noUid: { ...card(book), uid: undefined },
          noBook: { "@type": "Card", version: "1.0", uid: "u" },
          foreignBook: card(fake.defaultAddressBookId(B)),
          unknown: card(book, { favouriteColour: "red" }),
          badEmails: card(book, { emails: { e1: "x@example.org" } }),
          fine: card(book),
        },
      });
      const failed = answer.notCreated as Record<string, { type: string; properties: string[] }>;
      expect(Object.keys(failed).sort()).toEqual(["badEmails", "foreignBook", "noBook", "noType", "noUid", "noVersion", "unknown"]);
      expect(failed.noType).toEqual({ type: "invalidProperties", properties: ["@type"] });
      expect(failed.noVersion!.properties).toEqual(["version"]);
      expect(failed.noUid!.properties).toEqual(["uid"]);
      expect(failed.noBook!.properties).toEqual(["addressBookIds"]);
      expect(failed.foreignBook!.properties).toEqual(["addressBookIds"]);
      expect(failed.unknown!.properties).toEqual(["favouriteColour"]);
      expect(failed.badEmails!.properties).toEqual(["emails"]);
      expect(Object.keys(answer.created as object)).toEqual(["fine"]);
      expect(fake.contactsOf(A)).toHaveLength(1);
    });

    it("applies an update as a top-level property replacement and refuses unknown or nested keys", async () => {
      fake.addMailbox(A);
      const { id } = fake.addContact(A, ADA);
      const { answer } = await setCall({
        update: {
          [id]: { name: { full: "Replaced" } },
          nope: { name: { full: "x" } },
        },
      });
      expect(answer.updated).toEqual({ [id]: null });
      expect(answer.notUpdated).toEqual({ nope: { type: "notFound" } });
      expect(fake.contactsOf(A)[0]!.name).toEqual({ full: "Replaced" });
      const bad = (await setCall({ update: { [id]: { favouriteColour: "red", "name/full": "x" } } })).answer;
      expect(bad.notUpdated).toEqual({ [id]: { type: "invalidProperties", properties: ["favouriteColour", "name/full"] } });
      const noBook = (await setCall({ update: { [id]: { addressBookIds: null } } })).answer;
      expect(noBook.notUpdated).toEqual({ [id]: { type: "invalidProperties", properties: ["addressBookIds"] } });
      expect(fake.contactsOf(A)[0]!.name).toEqual({ full: "Replaced" });
    });

    it("answers notFound for ids of another account and for destroy twice", async () => {
      fake.addMailbox(A);
      fake.addMailbox(B);
      const theirs = fake.addContact(B, { name: { full: "Bob" } });
      const mine = fake.addContact(A, { name: { full: "Ann" } });
      const { answer } = await setCall({ destroy: [theirs.id, mine.id, mine.id] });
      // The second `mine.id` finds nothing: destroyed once.
      expect(answer.destroyed).toEqual([mine.id]);
      expect(answer.notDestroyed).toEqual({ [theirs.id]: { type: "notFound" }, [mine.id]: { type: "notFound" } });
      expect(fake.contactsOf(B)).toHaveLength(1);
    });

    it("answers unknownMethod without the contacts capability in `using`", async () => {
      fake.addMailbox(A);
      const { accessToken } = fake.tokensFor(A);
      const session = await fetchSession(accessToken);
      const [answer] = await jmapCall(session, accessToken, [["ContactCard/set", { accountId: session.accountId, destroy: [] }, "s"]], {
        using: [CORE],
      });
      expect(answer).toEqual(["error", { type: "unknownMethod" }, "s"]);
    });
  });
});

describe("reading the answer of a /set", () => {
  it("created: the server id; a refusal is upstream_rejected, silence is upstream_unavailable", () => {
    expect(createdOrThrow({ created: { c: { id: "ct9" } } }, "c")).toBe("ct9");
    expect(() => createdOrThrow({ notCreated: { c: { type: "invalidProperties" } } }, "c")).toThrow(MailError);
    // Neither created nor refused: nothing says what the server did, so the caller must decide.
    expect(() => createdOrThrow({}, "c")).toThrow(expect.objectContaining({ code: "upstream_unavailable" }));
    expect(() => createdOrThrow({ created: { c: { id: "../x" } } }, "c")).toThrow(expect.objectContaining({ code: "upstream_unavailable" }));
    expect(() => createdOrThrow({ notCreated: { c: { type: "x" } } }, "c")).toThrow(expect.objectContaining({ code: "upstream_rejected" }));
  });

  it("update: updated is done, notFound or silence is not_found, any other refusal is upstream_rejected", () => {
    const code = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return (e as MailError).code;
      }
      return "done";
    };
    expect(code(() => requireUpdated({ updated: { x: null } }, "x"))).toBe("done");
    expect(code(() => requireUpdated({ updated: { x: { a: 1 } } }, "x"))).toBe("done");
    expect(code(() => requireUpdated({ notUpdated: { x: { type: "notFound" } } }, "x"))).toBe("not_found");
    expect(code(() => requireUpdated({ notUpdated: { x: { type: "forbidden" } } }, "x"))).toBe("upstream_rejected");
    expect(code(() => requireUpdated({ notUpdated: { x: { type: "invalidProperties" } } }, "x"))).toBe("upstream_rejected");
    expect(code(() => requireUpdated({}, "x"))).toBe("not_found");
    expect(code(() => requireUpdated({ updated: { y: null } }, "x"))).toBe("not_found");
    expect(code(() => requireUpdated({ updated: 5 }, "x"))).toBe("upstream_rejected");
  });

  it("destroy: destroyed ids are deleted and the others named; none deleted is not_found only if every refusal is", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as MailError).code;
      }
      return "done";
    };
    expect(destroyResult({ destroyed: ["x"] }, ["x"])).toEqual({ deleted: 1, not_deleted: [] });
    expect(destroyResult({ destroyed: ["x", "z"], notDestroyed: { y: { type: "notFound" } } }, ["x", "y", "z"])).toEqual({
      deleted: 2,
      not_deleted: ["y"],
    });
    // Some deleted: the rest is named, whatever the reason; an id the answer does not mention stays too.
    expect(destroyResult({ destroyed: ["x"], notDestroyed: { y: { type: "forbidden" } } }, ["x", "y", "w"])).toEqual({
      deleted: 1,
      not_deleted: ["y", "w"],
    });
    expect(code(() => destroyResult({ notDestroyed: { x: { type: "notFound" } } }, ["x"]))).toBe("not_found");
    expect(code(() => destroyResult({ destroyed: null, notDestroyed: null }, ["x", "y"]))).toBe("not_found");
    expect(code(() => destroyResult({ destroyed: ["y"] }, ["x"]))).toBe("not_found");
    expect(code(() => destroyResult({ notDestroyed: { x: { type: "notFound" }, y: { type: "forbidden" } } }, ["x", "y"]))).toBe(
      "upstream_rejected",
    );
    expect(code(() => destroyResult({ notDestroyed: { x: { type: "forbidden" } } }, ["x"]))).toBe("upstream_rejected");
    expect(code(() => destroyResult({ destroyed: "x" }, ["x"]))).toBe("upstream_rejected");
  });

  it("the target of a create: the requested one if it is listed, else the default, else the first, else unsupported", () => {
    const list = [{ id: "a" }, { id: "b", isDefault: true }, { id: "c", isDefault: false }];
    expect(chooseTarget(list)).toBe("b");
    expect(chooseTarget(list, "c")).toBe("c");
    expect(chooseTarget([{ id: "a" }, { id: "c", isDefault: false }])).toBe("a");
    expect(() => chooseTarget(list, "z")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => chooseTarget([])).toThrow(expect.objectContaining({ code: "mailbox_unsupported" }));
    expect(() => chooseTarget([], "a")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

afterAll(() => {
  const names = (list: RecordedRequest[]) =>
    list.flatMap((r) => (Array.isArray(r.body?.methodCalls) ? (r.body.methodCalls as [string][]).map((c) => c[0]) : []));
  const sent = names([...allRequests, ...writeRequests]);
  expect(sent.length).toBeGreaterThan(0);
  // The only writes the adapter may send: `/set` of a contact card or a calendar event. Never
  // `/copy` or `/parse`, never a `/set` of an address book or a calendar.
  expect(sent.filter((n) => /\/(set|copy|parse)$/.test(n) && !["ContactCard/set", "CalendarEvent/set"].includes(n))).toEqual([]);
  expect(sent).toContain("ContactCard/set");
  // Everything else is a read.
  expect(sent.filter((n) => !/\/(get|query|set)$/.test(n))).toEqual([]);
});
