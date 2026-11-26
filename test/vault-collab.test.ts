/** The contacts and calendar operations through the mailbox vault: admission, permission, switch. */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAIL_LIMITS, MailError, type MailErrorCode } from "../src/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import type { Env } from "../src/env";
import { STALWART } from "../src/stalwart/endpoints";
import { type MailboxVault, vaultFor, WITH_ACCESS_TOKEN } from "../src/vault/mailbox-vault";
import { MailboxOperations } from "../src/vault/operations";
import { VaultMailbox } from "../src/vault/vault-mailbox";
import { createFakeStalwart, type FakeStalwart } from "./fake-stalwart";

const ORIGIN = "https://mail-mcp.test.example";
const A = "a@test.example";
const B = "b@test.example";
const T0 = 1_800_000_000_000;

let fake: FakeStalwart;
let testNo = 0;

/** Vault storage persists across the tests of a file: filler mailboxes give each test its own ids. */
beforeEach(() => {
  testNo++;
  fake = createFakeStalwart();
  for (let i = 0; i < testNo * 10; i++) fake.addMailbox(`filler${i}@filler.example`);
  vi.stubGlobal("fetch", fake.fetch);
  vi.spyOn(clock, "now").mockImplementation(() => T0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function signIn(email: string, options: { mailOnly?: boolean } = {}) {
  const accountId = fake.addMailbox(email).accountId;
  const stub = vaultFor(env, accountId);
  await stub.storeTokens({ accountId, email, origin: ORIGIN, ...fake.tokensFor(email, options) });
  return { stub, accountId, box: new VaultMailbox(env, accountId, email) };
}

async function expectCode(p: Promise<unknown>, code: MailErrorCode): Promise<void> {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MailError);
  expect((e as MailError).code).toBe(code);
}

const jmapPosts = () => fake.requests.filter((r) => r.url === `${STALWART.origin}/jmap/`);
const RANGE = { after: "2026-11-01T00:00:00Z", before: "2026-11-02T00:00:00Z", limit: 25, offset: 0 };

describe("collab through the vault", () => {
  it("answers contacts from the mailbox's own address book", async () => {
    const { box } = await signIn(A);
    fake.addMailbox(B);
    const mine = fake.addContact(A, { name: { full: "Ada" }, emails: { e: { address: "ada@example.org" } } });
    fake.addContact(B, { name: { full: "Bob" } });
    const found = await box.searchContacts({ limit: 10, offset: 0 });
    expect(found.contacts.map((c) => c.id)).toEqual([mine.id]);
    expect((await box.readContact({ contact_id: mine.id })).contact.name).toBe("Ada");
    await expectCode(box.readContact({ contact_id: fake.addContact(B, {}).id }), "not_found");
  });

  it("answers calendars and events from the mailbox's own account", async () => {
    const { box } = await signIn(A);
    fake.addMailbox(B);
    const mine = fake.addEvent(A, { title: "Standup", start: "2026-11-01T09:00:00" });
    fake.addEvent(B, { title: "Secret", start: "2026-11-01T09:00:00" });
    const { calendars } = await box.listCalendars();
    expect(calendars.map((c) => c.id)).toEqual([fake.defaultCalendarId(A)]);
    const found = await box.searchEvents(RANGE);
    expect(found.events.map((e) => [e.id, e.title])).toEqual([[mine.id, "Standup"]]);
    expect((await box.readEvent({ event_id: mine.id })).event.title).toBe("Standup");
    await expectCode(box.readEvent({ event_id: fake.addEvent(B, { start: "2026-11-01T09:00:00" }).id }), "not_found");
  });

  it("counts against the per-mailbox call limit, together with the mail calls", async () => {
    const { box } = await signIn(A);
    for (let i = 0; i < MAIL_LIMITS.toolCallsPerMinute - 1; i++) await box.searchContacts({ limit: 1, offset: 0 });
    await box.listMailboxes();
    await expectCode(box.searchContacts({ limit: 1, offset: 0 }), "rate_limited");
    await expectCode(box.readContact({ contact_id: "ct1" }), "rate_limited");
  });

  it("counts the calendar calls against the same limit", async () => {
    const { box } = await signIn(A);
    for (let i = 0; i < MAIL_LIMITS.toolCallsPerMinute - 2; i++) await box.listCalendars();
    await box.searchEvents(RANGE);
    await box.listMailboxes();
    await expectCode(box.listCalendars(), "rate_limited");
    await expectCode(box.searchEvents(RANGE), "rate_limited");
    await expectCode(box.readEvent({ event_id: "ev1" }), "rate_limited");
  });

  it("refuses a caller whose account or address does not match the connection", async () => {
    const { stub, accountId } = await signIn(A);
    const request = { op: "search_contacts", input: { limit: 10, offset: 0 } } as const;
    expect(await stub.collab("other", A, request)).toEqual({ ok: false, code: "account_mismatch" });
    expect(await stub.collab(accountId, B, request)).toEqual({ ok: false, code: "account_mismatch" });
    expect(await stub.collab(accountId, A.toUpperCase(), request)).toMatchObject({ ok: true });
  });

  it("validates the request: unknown operations, extra keys and bad input are invalid_input", async () => {
    const { stub, accountId } = await signIn(A);
    const loose = stub as unknown as { collab(id: string, email: string, request: unknown): Promise<unknown> };
    const call = (request: unknown) => loose.collab(accountId, A, request);
    for (const bad of [
      { op: "purge_contacts", input: { contact_id: "ct1" } },
      { op: "delete_contact", input: { contact_ids: ["ct1"], account_id: "x" } },
      { op: "delete_contact", input: { contact_ids: [] } },
      { op: "create_contact", input: {} },
      { op: "search_contacts", input: { limit: 99 } },
      { op: "search_contacts", input: {}, account_id: "x" },
      { op: "read_event", input: { event_id: "../x" } },
      "search_contacts",
      null,
    ]) {
      expect(await call(bad)).toEqual({ ok: false, code: "invalid_input" });
    }
    expect(jmapPosts()).toHaveLength(0);
  });
});

describe("permission of a connection", () => {
  it("a connection with the mail scope only answers not_granted for all five operations and sends no JMAP request", async () => {
    const { box } = await signIn(A, { mailOnly: true });
    await expectCode(box.searchContacts({ limit: 10, offset: 0 }), "not_granted");
    await expectCode(box.readContact({ contact_id: "ct1" }), "not_granted");
    await expectCode(box.listCalendars(), "not_granted");
    await expectCode(box.searchEvents(RANGE), "not_granted");
    await expectCode(box.readEvent({ event_id: "ev1" }), "not_granted");
    expect(jmapPosts()).toHaveLength(0);
    // Mail still works with that connection.
    await box.listMailboxes();
    expect(jmapPosts()).toHaveLength(1);
  });
});

describe("feature switch", () => {
  const caller = (email: string, accountId: string) => ({ accountId, email });

  it.each([
    ["contacts,calendars", "contacts", "not_granted"],
    ["contacts,calendars", "calendars", "not_granted"],
    ["calendars", "calendars", "not_granted"],
    ["contacts", "contacts", "not_granted"],
  ])("DISABLED_FEATURES=%j: %s is %s", async (disabled, area, expected) => {
    const email = A;
    const { stub, accountId } = await signIn(email);
    const before = jmapPosts().length;
    const requests =
      area === "contacts"
        ? [{ op: "search_contacts", input: { limit: 10, offset: 0 } }, { op: "read_contact", input: { contact_id: "ct1" } }]
        : [{ op: "list_calendars" }, { op: "search_events", input: RANGE }, { op: "read_event", input: { event_id: "ev1" } }];
    const answers = await runInDurableObject(stub, (vault: MailboxVault, state) => {
      const ops = new MailboxOperations({
        sql: state.storage.sql,
        env: { ...env, DISABLED_FEATURES: disabled } as Env,
        withAccessToken: (fn) => vault[WITH_ACCESS_TOKEN](fn),
      });
      return Promise.all(requests.map((r) => ops.collab(caller(email, accountId), r)));
    });
    for (const answer of answers) expect(answer).toEqual({ ok: false, code: expected });
    expect(jmapPosts().length).toBe(before);
  });

  it("serves the area that is left on", async () => {
    const { stub, accountId } = await signIn(A);
    fake.addContact(A, { name: { full: "Ada" } });
    const answer = await runInDurableObject(stub, (vault: MailboxVault, state) =>
      new MailboxOperations({
        sql: state.storage.sql,
        env: { ...env, DISABLED_FEATURES: "calendars" } as Env,
        withAccessToken: (fn) => vault[WITH_ACCESS_TOKEN](fn),
      }).collab(caller(A, accountId), { op: "search_contacts", input: { limit: 10, offset: 0 } }),
    );
    expect(answer).toMatchObject({ ok: true, value: { contacts: [{ name: "Ada" }] } });
  });

  it("treats an invalid DISABLED_FEATURES setting as no area", async () => {
    const { stub, accountId } = await signIn(A);
    const answer = await runInDurableObject(stub, (vault: MailboxVault, state) =>
      new MailboxOperations({
        sql: state.storage.sql,
        env: { ...env, DISABLED_FEATURES: "files" } as Env,
        withAccessToken: (fn) => vault[WITH_ACCESS_TOKEN](fn),
      }).collab(caller(A, accountId), { op: "search_contacts", input: { limit: 10, offset: 0 } }),
    );
    expect(answer).toEqual({ ok: false, code: "not_granted" });
  });
});

describe("writing contacts and events through the vault", () => {
  const caller = (email: string, accountId: string) => ({ accountId, email });
  const WRITES = [
    { op: "create_contact", input: { name: "Ada" } },
    { op: "update_contact", input: { contact_id: "ct1", name: "Ada" } },
    { op: "delete_contact", input: { contact_ids: ["ct1"] } },
    { op: "create_event", input: { title: "Standup", date: "2026-11-27" } },
    { op: "update_event", input: { event_id: "ev1", title: "Standup" } },
    { op: "delete_event", input: { event_ids: ["ev1"] } },
  ] as const;

  it("creates, changes and deletes a contact in the mailbox's own address book", async () => {
    const { box } = await signIn(A);
    fake.addMailbox(B);
    const other = fake.addContact(B, { name: { full: "Bob" } });
    const created = await box.createContact({ name: "Ada", emails: [{ address: "ada@example.org" }] });
    expect(created.address_book_id).toBe(fake.defaultAddressBookId(A));
    expect(await box.updateContact({ contact_id: created.contact_id, job_title: "Engineer" })).toEqual({
      contact_id: created.contact_id,
    });
    expect((await box.readContact({ contact_id: created.contact_id })).contact).toMatchObject({
      name: "Ada",
      titles: ["Engineer"],
    });
    await expectCode(box.updateContact({ contact_id: other.id, name: "Mine now" }), "not_found");
    await expectCode(box.deleteContact({ contact_ids: [other.id] }), "not_found");
    expect(await box.deleteContact({ contact_ids: [created.contact_id] })).toEqual({ deleted: 1, not_deleted: [] });
    await expectCode(box.readContact({ contact_id: created.contact_id }), "not_found");
  });

  it("creates, changes and deletes an event in the mailbox's own calendar", async () => {
    const { box } = await signIn(A);
    fake.addMailbox(B);
    const other = fake.addEvent(B, { title: "Bob's", start: "2027-03-01T09:00:00" });
    const created = await box.createEvent({ title: "Standup", start: "2027-03-01T09:00:00Z", end: "2027-03-01T09:15:00Z", time_zone: "Europe/Berlin" });
    expect(created).toEqual({ event_id: expect.any(String), calendar_id: fake.defaultCalendarId(A), invitations: 0, deduplicated: false });
    expect(await box.updateEvent({ event_id: created.event_id, location: "Room 2", recurrence: { frequency: "weekly", count: 4 } })).toEqual({
      event_id: created.event_id,
      invitations: 0,
      deduplicated: false,
    });
    expect((await box.readEvent({ event_id: created.event_id })).event).toMatchObject({
      title: "Standup",
      local_start: "2027-03-01T10:00:00",
      time_zone: "Europe/Berlin",
      location: "Room 2",
      recurring: true,
      recurrence: "weekly, 4 times",
    });
    await expectCode(box.updateEvent({ event_id: other.id, title: "Mine now" }), "not_found");
    await expectCode(box.deleteEvent({ event_ids: [other.id] }), "not_found");
    expect(await box.deleteEvent({ event_ids: [created.event_id] })).toEqual({
      deleted: 1,
      not_deleted: [],
      cancellations: 0,
      cancelled_attendees: 0,
    });
    await expectCode(box.readEvent({ event_id: created.event_id }), "not_found");
    expect(fake.eventsOf(B)).toHaveLength(1);
  });

  it("counts every one of the six write operations against the per-mailbox call limit", async () => {
    const { box } = await signIn(A);
    for (let i = 0; i < MAIL_LIMITS.toolCallsPerMinute - 2; i++) await box.searchContacts({ limit: 1, offset: 0 });
    await box.createContact({ name: "Ada" });
    await box.listMailboxes();
    await expectCode(box.createContact({ name: "Bob" }), "rate_limited");
    await expectCode(box.updateContact({ contact_id: "ct1", name: "x" }), "rate_limited");
    await expectCode(box.deleteContact({ contact_ids: ["ct1"] }), "rate_limited");
    await expectCode(box.createEvent({ title: "x", date: "2026-11-27" }), "rate_limited");
    await expectCode(box.updateEvent({ event_id: "ev1", title: "x" }), "rate_limited");
    await expectCode(box.deleteEvent({ event_ids: ["ev1"] }), "rate_limited");
  });

  it("a connection with the mail scope only answers not_granted for all six write operations and sends nothing", async () => {
    const { stub, accountId } = await signIn(A, { mailOnly: true });
    const loose = stub as unknown as { collab(id: string, email: string, request: unknown): Promise<unknown> };
    for (const request of WRITES) {
      expect(await loose.collab(accountId, A, request)).toEqual({ ok: false, code: "not_granted" });
    }
    expect(jmapPosts()).toHaveLength(0);
  });

  it.each([
    ["contacts,calendars", "contacts"],
    ["contacts,calendars", "calendars"],
    ["calendars", "calendars"],
    ["contacts", "contacts"],
  ])("DISABLED_FEATURES=%j: the write operations of %s are refused and send nothing", async (disabled, area) => {
    const { stub, accountId } = await signIn(A);
    const before = jmapPosts().length;
    const requests = WRITES.filter((r) => r.op.endsWith(area === "contacts" ? "_contact" : "_event"));
    expect(requests).toHaveLength(3);
    const answers = await runInDurableObject(stub, (vault: MailboxVault, state) => {
      const ops = new MailboxOperations({
        sql: state.storage.sql,
        env: { ...env, DISABLED_FEATURES: disabled } as Env,
        withAccessToken: (fn) => vault[WITH_ACCESS_TOKEN](fn),
      });
      return Promise.all(requests.map((r) => ops.collab(caller(A, accountId), r)));
    });
    for (const answer of answers) expect(answer).toEqual({ ok: false, code: "not_granted" });
    expect(jmapPosts().length).toBe(before);
  });

  it("rejects a write request with a bad shape as invalid_input", async () => {
    const { stub, accountId } = await signIn(A);
    const loose = stub as unknown as { collab(id: string, email: string, request: unknown): Promise<unknown> };
    for (const bad of [
      { op: "create_contact", input: {} },
      { op: "update_contact", input: { contact_id: "ct1" } },
      { op: "delete_event", input: { event_ids: ["ev1"], account_id: "x" } },
    ]) {
      expect(await loose.collab(accountId, A, bad)).toEqual({ ok: false, code: "invalid_input" });
    }
    expect(jmapPosts()).toHaveLength(0);
  });

  describe("deleting in batches", () => {
    const contactIds = (n: number) => Array.from({ length: n }, () => fake.addContact(A, { name: { full: "x" } }).id);

    it("deletes up to 50 contacts in one request; a duplicate counts once", async () => {
      const { box } = await signIn(A);
      const ids = contactIds(50);
      const before = jmapPosts().length;
      expect(await box.deleteContact({ contact_ids: ids })).toEqual({ deleted: 50, not_deleted: [] });
      expect(jmapPosts().length - before).toBe(1);
      expect(fake.contactsOf(A)).toEqual([]);
      const [one, two] = contactIds(2);
      expect(await box.deleteContact({ contact_ids: [one!, two!, one!] })).toEqual({ deleted: 2, not_deleted: [] });
    });

    it("refuses 51 ids and an empty list as invalid input, and sends nothing", async () => {
      const { stub, accountId } = await signIn(A);
      const loose = stub as unknown as { collab(id: string, email: string, request: unknown): Promise<unknown> };
      const ids = Array.from({ length: 51 }, (_, i) => `ct${i}`);
      expect(await loose.collab(accountId, A, { op: "delete_contact", input: { contact_ids: ids } })).toEqual({
        ok: false,
        code: "invalid_input",
      });
      expect(await loose.collab(accountId, A, { op: "delete_event", input: { event_ids: [] } })).toEqual({
        ok: false,
        code: "invalid_input",
      });
      expect(jmapPosts()).toHaveLength(0);
    });

    it("names the ids that stayed, leaves another mailbox's contact alone, and not_found when none was deleted", async () => {
      const { box } = await signIn(A);
      fake.addMailbox(B);
      const theirs = fake.addContact(B, { name: { full: "Bob" } });
      const [mine] = contactIds(1);
      expect(await box.deleteContact({ contact_ids: [theirs.id, mine!, "missing"] })).toEqual({
        deleted: 1,
        not_deleted: [theirs.id, "missing"],
      });
      expect(fake.contactsOf(B)).toHaveLength(1);
      await expectCode(box.deleteContact({ contact_ids: [theirs.id] }), "not_found");
    });

    it("deletes up to 50 events without attendees in one silent request, after one read", async () => {
      const { box } = await signIn(A);
      const ids = Array.from({ length: 50 }, (_, i) => fake.addEvent(A, { start: `2027-03-01T09:${String(i).padStart(2, "0")}:00` }).id);
      const before = jmapPosts().length;
      expect(await box.deleteEvent({ event_ids: ids })).toEqual({ deleted: 50, not_deleted: [], cancellations: 0, cancelled_attendees: 0 });
      const posts = jmapPosts().slice(before);
      expect(posts.map((r) => r.body.methodCalls.map((c: [string]) => c[0]))).toEqual([["CalendarEvent/get"], ["CalendarEvent/set"]]);
      expect(posts[1]!.body.methodCalls[0][1]).toMatchObject({ sendSchedulingMessages: false });
      expect(fake.eventsOf(A)).toEqual([]);
    });

    it("has no daily limit on deletions", async () => {
      const { box } = await signIn(A);
      for (let i = 0; i < 3; i++) await box.deleteContact({ contact_ids: contactIds(50) });
      expect(fake.contactsOf(A)).toEqual([]);
    });
  });
});
