import { MailError } from "../src/mail";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLAB_LIMITS, type CollabAdapter } from "../src/collab";
import { fetchSession, jmapCall } from "../src/jmap/jmap-client";
import { JmapCollabAdapter } from "../src/jmap/jmap-collab-adapter";
import { STALWART } from "../src/stalwart/endpoints";
import { createFakeStalwart, type FakeStalwart, type RecordedRequest } from "./fake-stalwart";

const A = "a@test.example";
const B = "b@test.example";
const CONTACTS = "urn:ietf:params:jmap:contacts";
const CORE = "urn:ietf:params:jmap:core";

let fake: FakeStalwart;
const allRequests: RecordedRequest[] = [];

beforeEach(() => {
  fake = createFakeStalwart();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  allRequests.push(...fake.requests);
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
    await expectMailError(adapter.searchEvents(range as never), "not_granted");
    await expectMailError(adapter.readEvent({ event_id: "ev1" }), "not_granted");
    expect(fake.requests.length).toBe(before);
  });

  it("the session lists an area only when the token's scopes include it", async () => {
    fake.addMailbox(A);
    const full = await fetchSession(fake.tokensFor(A).accessToken);
    expect(full.capabilities).toEqual(expect.arrayContaining([CONTACTS, "urn:ietf:params:jmap:calendars"]));
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

describe("read only", () => {
  it("no request of these tests contains a /set, /copy or /parse method", () => {
    expect(allRequests.length).toBeGreaterThan(0);
  });
});

afterAll(() => {
  const names = allRequests.flatMap((r) =>
    Array.isArray(r.body?.methodCalls) ? (r.body.methodCalls as [string][]).map((c) => c[0]) : [],
  );
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((n) => /\/(set|copy|parse)$/.test(n))).toEqual([]);
});
