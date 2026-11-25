/**
 * Event writes that make the mail server notify people, through the mailbox vault: they are sends
 * (allow-list, the shared daily limit, exactly once), and the ones that notify nobody cost nothing.
 * Mirrors the `send_mail` tests in `vault-limits.test.ts`.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAIL_LIMITS, MailError, type MailErrorCode, type OutgoingMessage } from "../src/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import type { CreateEventInputT, EventAudience } from "../src/collab";
import type { Env } from "../src/env";
import { STALWART } from "../src/stalwart/endpoints";
import { createNotice, deleteNotice, updateNotice } from "../src/vault/event-notices";
import { eventWriteFingerprint, takeSend } from "../src/vault/limits";
import { type MailboxVault, vaultFor, WITH_ACCESS_TOKEN } from "../src/vault/mailbox-vault";
import { MailboxOperations } from "../src/vault/operations";
import { VaultMailbox } from "../src/vault/vault-mailbox";
import { createFakeStalwart, type FakeStalwart, type RecordedRequest } from "./fake-stalwart";

const ORIGIN = "https://mail-mcp.test.example";
const A = "a@test.example";
/** The only recipient on the test SEND_ALLOWLIST. */
const OK = "ok@test.example";
const STRANGER = "stranger@test.example";
/** 2027-01-15T08:00:00Z. In the future, so alarms scheduled from it never fire during the run. */
const T0 = 1_800_000_000_000;
const SECOND = 1000;
const DAY = 86_400 * SECOND;

type Stub = DurableObjectStub<MailboxVault>;

let fake: FakeStalwart;
let now = T0;
let testNo = 0;

/** Vault storage persists across the tests of a file: filler mailboxes give each test its own ids. */
beforeEach(() => {
  testNo++;
  fake = createFakeStalwart();
  for (let i = 0; i < testNo * 10; i++) fake.addMailbox(`filler${i}@filler.example`);
  vi.stubGlobal("fetch", fake.fetch);
  now = T0;
  vi.spyOn(clock, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function signIn(email: string): Promise<{ stub: Stub; accountId: string; box: VaultMailbox }> {
  const accountId = fake.addMailbox(email).accountId;
  const stub = vaultFor(env, accountId);
  await stub.storeTokens({ accountId, email, origin: ORIGIN, ...fake.tokensFor(email) });
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

function slowUpstream(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, 10));
    return fake.fetch(input, init);
  });
}

const methodCalls = (r: RecordedRequest): [string, Record<string, unknown>, string][] =>
  Array.isArray(r.body?.methodCalls) ? r.body.methodCalls : [];
/** The arguments of every `CalendarEvent/set` sent so far. */
const eventSets = () => fake.requests.flatMap((r) => methodCalls(r).filter((c) => c[0] === "CalendarEvent/set").map((c) => c[1]));

function sendsCounted(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (_v: MailboxVault, state) => {
    const row = state.storage.sql.exec("SELECT count FROM usage_counter WHERE name = 'send'").toArray()[0];
    return row ? Number(row.count) : 0;
  });
}

function recentSends(stub: Stub): Promise<Record<string, unknown>[]> {
  return runInDurableObject(stub, (_v: MailboxVault, state) => state.storage.sql.exec("SELECT * FROM recent_sends").toArray());
}

function countSends(stub: Stub, n: number): Promise<void> {
  return runInDurableObject(stub, (_v: MailboxVault, state) => {
    for (let i = 0; i < n; i++) expect(takeSend(state.storage.sql, clock.now())).not.toBeNull();
  });
}

/** The vault's operations with another environment (production, a longer allow-list). */
function opsWith(stub: Stub, overrides: Partial<Env>, run: (ops: MailboxOperations) => Promise<unknown>): Promise<unknown> {
  return runInDurableObject(stub, (vault: MailboxVault, state) =>
    run(
      new MailboxOperations({
        sql: state.storage.sql,
        env: { ...env, ...overrides } as Env,
        withAccessToken: (fn) => vault[WITH_ACCESS_TOKEN](fn),
      }),
    ),
  );
}

/** An hour on 2027-03-01, six weeks after T0. */
const FUTURE = { start: "2027-03-01T09:00:00Z", end: "2027-03-01T10:00:00Z" };
const invite: CreateEventInputT = { title: "Planning", ...FUTURE, participants: [{ email: OK, name: "Ok" }] };
const mail: OutgoingMessage = { to: [OK], cc: [], bcc: [], subject: "Hello", body: "Hi there" };

/** Adds an event with `OK` as attendee straight to the fake (no send used). */
const invited = (start = "2027-03-01T09:00:00") =>
  fake.addEvent(A, {
    title: "Invited",
    start,
    organizerCalendarAddress: `mailto:${A}`,
    participants: { o: { calendarAddress: `mailto:${A}`, roles: { owner: true } }, p: { calendarAddress: `mailto:${OK}` } },
  }).id;

describe("a notifying create", () => {
  it("the same create twice: one event, one invitation, the second answer deduplicated", async () => {
    const { stub, box } = await signIn(A);
    const r1 = await box.createEvent(invite);
    const r2 = await box.createEvent({ ...invite, participants: [{ email: "OK@Test.Example", name: "Ok" }] });
    expect(r1).toEqual({ event_id: expect.any(String), calendar_id: fake.defaultCalendarId(A), invitations: 1, deduplicated: false });
    expect(r2).toEqual({ ...r1, deduplicated: true });
    expect(fake.eventsOf(A)).toHaveLength(1);
    expect(fake.schedulingMessages(A)).toEqual([{ kind: "REQUEST", eventId: r1.event_id, attendees: [OK] }]);
    expect(eventSets().map((s) => s.sendSchedulingMessages)).toEqual([true]);
    expect(await sendsCounted(stub)).toBe(1);
    // Only ids and a count are kept, no content.
    expect(await recentSends(stub)).toEqual([
      {
        fingerprint: await eventWriteFingerprint("create_event", invite),
        sent_at: T0,
        state: "sent",
        message_id: `${r1.event_id}/${r1.calendar_id}`,
        recipients: 1,
      },
    ]);
    // After the dedupe window, the same create is a new event.
    now = T0 + (MAIL_LIMITS.sendDedupeSeconds + 1) * SECOND;
    expect(await box.createEvent(invite)).toMatchObject({ deduplicated: false });
    expect(fake.eventsOf(A)).toHaveLength(2);
  });

  it("two identical creates at the same time make one event", async () => {
    const { box } = await signIn(A);
    slowUpstream();
    const [r1, r2] = await Promise.all([box.createEvent(invite), box.createEvent(invite)]);
    expect(r1.event_id).toBe(r2.event_id);
    expect([r1.deduplicated, r2.deduplicated].sort()).toEqual([false, true]);
    expect(fake.eventsOf(A)).toHaveLength(1);
    expect(fake.schedulingMessages(A)).toHaveLength(1);
  });

  it("an unknown outcome is send_unconfirmed, stays counted, and an identical retry sends nothing", async () => {
    const { stub, box } = await signIn(A);
    fake.failNextEventWrite("accepted-then-503");
    await expectCode(box.createEvent(invite), "send_unconfirmed");
    const n = fake.requests.length;
    await expectCode(box.createEvent(invite), "send_unconfirmed");
    expect(fake.requests).toHaveLength(n);
    expect(fake.eventsOf(A)).toHaveLength(1);
    expect(fake.schedulingMessages(A)).toHaveLength(1);
    expect(await sendsCounted(stub)).toBe(1);
    expect(await recentSends(stub)).toEqual([expect.objectContaining({ state: "unconfirmed", message_id: null })]);

    // The same for a network failure on the set request: nothing may have reached the server, but nobody can tell.
    fake.failNextEventWrite("network");
    const other = { ...invite, title: "Other" };
    await expectCode(box.createEvent(other), "send_unconfirmed");
    await expectCode(box.createEvent(other), "send_unconfirmed");
    expect(await sendsCounted(stub)).toBe(2);
  });

  it("a definite refusal gives the send back and forgets the create", async () => {
    const { stub, box, accountId } = await signIn(A);
    const unreachable = { ...invite, participants: [{ email: "nobody@unreachable.example" }] };
    expect(
      await opsWith(stub, { ENVIRONMENT: "production" }, (ops) => ops.collab({ accountId, email: A }, { op: "create_event", input: unreachable })),
    ).toEqual({ ok: false, code: "upstream_rejected" });
    expect(await sendsCounted(stub)).toBe(0);
    expect(await recentSends(stub)).toEqual([]);
    expect(fake.eventsOf(A)).toEqual([]);
    // A calendar that is not this account's: refused before the set, nothing counted.
    await expectCode(box.createEvent({ ...invite, calendar_id: "cal99999" }), "not_found");
    expect(await sendsCounted(stub)).toBe(0);
    expect(await recentSends(stub)).toEqual([]);
  });

  it("a create without participants costs no send, is not deduplicated and does not notify", async () => {
    const { stub, box } = await signIn(A);
    const quiet = { title: "Focus", ...FUTURE };
    expect(await box.createEvent(quiet)).toMatchObject({ invitations: 0, deduplicated: false });
    expect(await box.createEvent(quiet)).toMatchObject({ invitations: 0, deduplicated: false });
    expect(fake.eventsOf(A)).toHaveLength(2);
    expect(eventSets().map((s) => s.sendSchedulingMessages)).toEqual([false, false]);
    expect(await sendsCounted(stub)).toBe(0);
    expect(await recentSends(stub)).toEqual([]);
  });

  it("refuses the mailbox's own address as a participant and gives the send back", async () => {
    const { stub, accountId } = await signIn(A);
    const own = { ...invite, participants: [{ email: A }] };
    expect(
      await opsWith(stub, { ENVIRONMENT: "production" }, (ops) => ops.collab({ accountId, email: A }, { op: "create_event", input: own })),
    ).toEqual({ ok: false, code: "invalid_input" });
    expect(await sendsCounted(stub)).toBe(0);
    expect(fake.eventsOf(A)).toEqual([]);
  });
});

describe("a notifying update", () => {
  it("is read first, then sent once: the identical update again returns the first result and sends nothing", async () => {
    const { stub, box } = await signIn(A);
    const id = invited();
    const r1 = await box.updateEvent({ event_id: id, title: "Moved" });
    const r2 = await box.updateEvent({ event_id: id, title: "Moved" });
    expect(r1).toEqual({ event_id: id, invitations: 1 });
    expect(r2).toEqual(r1);
    expect(eventSets()).toHaveLength(1);
    expect(eventSets()[0]!.sendSchedulingMessages).toBe(true);
    expect(fake.schedulingMessages(A)).toEqual([{ kind: "REQUEST", eventId: id, attendees: [OK] }]);
    expect(await sendsCounted(stub)).toBe(1);
    // A different update is another send.
    await box.updateEvent({ event_id: id, title: "Moved again" });
    expect(await sendsCounted(stub)).toBe(2);
  });

  it("removing every attendee still notifies them (a cancellation) and costs a send", async () => {
    const { stub, box } = await signIn(A);
    const id = invited();
    expect(await box.updateEvent({ event_id: id, participants: [] })).toEqual({ event_id: id, invitations: 1 });
    expect(fake.schedulingMessages(A)).toEqual([{ kind: "CANCEL", eventId: id, attendees: [OK] }]);
    expect(await sendsCounted(stub)).toBe(1);
  });

  it("an update of an event without attendees, that adds none, costs nothing", async () => {
    const { stub, box } = await signIn(A);
    const id = fake.addEvent(A, { title: "Alone", start: "2027-03-01T09:00:00" }).id;
    expect(await box.updateEvent({ event_id: id, title: "Still alone" })).toEqual({ event_id: id, invitations: 0 });
    expect(eventSets()[0]!.sendSchedulingMessages).toBe(false);
    expect(await sendsCounted(stub)).toBe(0);
  });

  it("an unknown id is not_found before anything is written or counted", async () => {
    const { stub, box } = await signIn(A);
    await expectCode(box.updateEvent({ event_id: "ev99999", title: "x", participants: [{ email: OK }] }), "not_found");
    expect(eventSets()).toEqual([]);
    expect(await sendsCounted(stub)).toBe(0);
  });

  it("an unknown outcome is send_unconfirmed and blocks the identical update for the window", async () => {
    const { stub, box } = await signIn(A);
    const id = invited();
    fake.failNextEventWrite("accepted-then-invalid-json");
    await expectCode(box.updateEvent({ event_id: id, title: "Moved" }), "send_unconfirmed");
    await expectCode(box.updateEvent({ event_id: id, title: "Moved" }), "send_unconfirmed");
    expect(eventSets()).toHaveLength(1);
    expect(await sendsCounted(stub)).toBe(1);
  });
});

describe("a notifying delete", () => {
  it("costs one send per notifying event; events without attendees go in a second, silent request", async () => {
    const { stub, box } = await signIn(A);
    const one = invited();
    const two = invited("2027-03-02T09:00:00");
    const alone = fake.addEvent(A, { start: "2027-03-01T09:00:00" }).id;
    expect(await box.deleteEvent({ event_ids: [one, alone, two, "ev99999"] })).toEqual({
      deleted: 3,
      not_deleted: ["ev99999"],
      cancellations: 2,
      cancelled_attendees: 2,
    });
    expect(eventSets()).toEqual([
      expect.objectContaining({ destroy: [one, two], sendSchedulingMessages: true }),
      expect.objectContaining({ destroy: [alone, "ev99999"], sendSchedulingMessages: false }),
    ]);
    expect(fake.schedulingMessages(A).map((m) => m.kind)).toEqual(["CANCEL", "CANCEL"]);
    expect(await sendsCounted(stub)).toBe(2);
    // Again: nothing left to delete, nobody notified, nothing counted.
    await expectCode(box.deleteEvent({ event_ids: [one, two] }), "not_found");
    expect(await sendsCounted(stub)).toBe(2);
    expect(fake.schedulingMessages(A)).toHaveLength(2);
  });

  it("3 notifying events with 2 sends left: nothing is deleted", async () => {
    const { stub, box } = await signIn(A);
    const ids = [invited(), invited("2027-03-02T09:00:00"), invited("2027-03-03T09:00:00")];
    await countSends(stub, MAIL_LIMITS.sendsPerDay - 2);
    const n = eventSets().length;
    await expectCode(box.deleteEvent({ event_ids: ids }), "send_limit_reached");
    expect(eventSets()).toHaveLength(n);
    expect(fake.eventsOf(A)).toHaveLength(3);
    expect(await sendsCounted(stub)).toBe(MAIL_LIMITS.sendsPerDay - 2);
    // Two fit.
    expect(await box.deleteEvent({ event_ids: ids.slice(0, 2) })).toMatchObject({ deleted: 2, cancellations: 2 });
    expect(await sendsCounted(stub)).toBe(MAIL_LIMITS.sendsPerDay);
  });

  it("gives back the sends of events that were not deleted, and keeps them after an unknown outcome", async () => {
    const { stub, box } = await signIn(A);
    const one = invited();
    const two = invited("2027-03-02T09:00:00");
    // `two` disappears between the read and the delete: definitely not cancelled.
    const fetchFake = fake.fetch;
    let removed = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const text = init?.body === undefined ? "" : String(init.body);
      if (!removed && text.includes("CalendarEvent/set")) {
        removed = true;
        await fetchFake(`${STALWART.origin}/jmap/`, {
          method: "POST",
          headers: { Authorization: `Bearer ${fake.tokensFor(A).accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
            methodCalls: [["CalendarEvent/set", { accountId: JSON.parse(text).methodCalls[0][1].accountId, destroy: [two] }, "x"]],
          }),
        });
      }
      return fetchFake(input, init);
    });
    expect(await box.deleteEvent({ event_ids: [one, two] })).toMatchObject({ deleted: 1, not_deleted: [two], cancellations: 1 });
    expect(await sendsCounted(stub)).toBe(1);
    vi.stubGlobal("fetch", fake.fetch);

    const three = invited("2027-03-03T09:00:00");
    fake.failNextEventWrite("accepted-then-503");
    await expectCode(box.deleteEvent({ event_ids: [three] }), "send_unconfirmed");
    expect(await sendsCounted(stub)).toBe(2);
  });
});

describe("the daily send limit is shared by mail and notifying event writes", () => {
  it("50 in total, whichever kind; the 51st is refused for each kind and sends nothing", async () => {
    const { stub, box } = await signIn(A);
    for (let i = 0; i < 20; i++) await box.sendMail({ ...mail, body: `message ${i}` });
    for (let i = 0; i < 20; i++) await box.createEvent({ ...invite, title: `Event ${i}` });
    const ids = Array.from({ length: 5 }, (_, i) => invited(`2027-04-0${i + 1}T09:00:00`));
    for (let i = 0; i < 5; i++) await box.updateEvent({ event_id: ids[i]!, title: `Moved ${i}` });
    await box.deleteEvent({ event_ids: ids });
    expect(await sendsCounted(stub)).toBe(MAIL_LIMITS.sendsPerDay);

    const before = fake.requests.length;
    await expectCode(box.sendMail({ ...mail, body: "one too many" }), "send_limit_reached");
    await expectCode(box.createEvent({ ...invite, title: "one too many" }), "send_limit_reached");
    const last = invited("2027-05-01T09:00:00");
    const reads = fake.requests.length;
    await expectCode(box.updateEvent({ event_id: last, title: "one too many" }), "send_limit_reached");
    await expectCode(box.deleteEvent({ event_ids: [last] }), "send_limit_reached");
    // Only the reads of the update and the delete went out.
    expect(fake.requests.length - reads).toBe(2);
    expect(eventSets().filter((s) => JSON.stringify(s).includes("one too many"))).toEqual([]);
    expect(fake.sent(A)).toHaveLength(20);
    expect(before).toBeGreaterThan(0);

    // A write that notifies nobody still works.
    expect(await box.createEvent({ title: "Focus", ...FUTURE })).toMatchObject({ invitations: 0 });
    // The next UTC day starts at 0.
    now = (Math.floor(T0 / DAY) + 1) * DAY;
    expect(await box.createEvent({ ...invite, title: "tomorrow" })).toMatchObject({ deduplicated: false, invitations: 1 });
  });
});

describe("staging: only allow-listed attendees, checked before anything is written", () => {
  const stranger = () =>
    fake.addEvent(A, { title: "With a stranger", start: "2027-03-01T09:00:00", participants: { p: { calendarAddress: `mailto:${STRANGER}` } } }).id;

  it("refuses a create, an update that adds one, an update of an event that has one, and its deletion", async () => {
    const { stub, box } = await signIn(A);
    const mine = invited();
    const theirs = stranger();
    const sets = eventSets().length;
    await expectCode(box.createEvent({ ...invite, participants: [{ email: OK }, { email: STRANGER }] }), "recipient_not_allowed");
    await expectCode(box.updateEvent({ event_id: mine, participants: [{ email: OK }, { email: STRANGER }] }), "recipient_not_allowed");
    await expectCode(box.updateEvent({ event_id: theirs, title: "Renamed" }), "recipient_not_allowed");
    await expectCode(box.updateEvent({ event_id: theirs, participants: [{ email: OK }] }), "recipient_not_allowed");
    await expectCode(box.deleteEvent({ event_ids: [theirs] }), "recipient_not_allowed");
    await expectCode(box.deleteEvent({ event_ids: [mine, theirs] }), "recipient_not_allowed");
    expect(eventSets()).toHaveLength(sets);
    expect(fake.eventsOf(A)).toHaveLength(2);
    expect(fake.schedulingMessages(A)).toEqual([]);
    expect(await sendsCounted(stub)).toBe(0);
  });

  it("production allows any address; a longer allow-list allows its own", async () => {
    const { stub, accountId } = await signIn(A);
    const input = { ...invite, participants: [{ email: OK }, { email: STRANGER }] };
    expect(await opsWith(stub, { ENVIRONMENT: "production" }, (ops) => ops.collab({ accountId, email: A }, { op: "create_event", input }))).toMatchObject({
      ok: true,
      value: { invitations: 2 },
    });
    expect(
      await opsWith(stub, { SEND_ALLOWLIST: `${OK}, ${STRANGER}` }, (ops) =>
        ops.collab({ accountId, email: A }, { op: "create_event", input: { ...input, title: "Second" } }),
      ),
    ).toMatchObject({ ok: true, value: { invitations: 2 } });
    expect(fake.schedulingMessages(A).map((m) => m.attendees)).toEqual([[OK, STRANGER], [OK, STRANGER]]);
  });

  it("a past event with a stranger may be changed and deleted: nobody is notified", async () => {
    const { stub, box } = await signIn(A);
    const old = fake.addEvent(A, { title: "Old", start: "2026-12-01T09:00:00", participants: { p: { calendarAddress: `mailto:${STRANGER}` } } }).id;
    expect(await box.updateEvent({ event_id: old, title: "Old, renamed" })).toEqual({ event_id: old, invitations: 0 });
    expect(await box.deleteEvent({ event_ids: [old] })).toMatchObject({ deleted: 1, cancellations: 0, cancelled_attendees: 0 });
    expect(eventSets().map((s) => s.sendSchedulingMessages)).toEqual([false, false]);
    expect(await sendsCounted(stub)).toBe(0);
  });
});

describe("events that ended in the past", () => {
  it("a create, update and delete with participants send sendSchedulingMessages: false, cost nothing, report 0", async () => {
    const { stub, box } = await signIn(A);
    const past = { start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z" };
    const created = await box.createEvent({ ...invite, ...past });
    expect(created).toMatchObject({ invitations: 0, deduplicated: false });
    expect(await box.updateEvent({ event_id: created.event_id, title: "Minutes" })).toEqual({ event_id: created.event_id, invitations: 0 });
    // Moving it back into the future notifies again.
    expect(await box.updateEvent({ event_id: created.event_id, ...FUTURE })).toEqual({ event_id: created.event_id, invitations: 1 });
    // And moving it into the past again does not.
    expect(await box.updateEvent({ event_id: created.event_id, ...past })).toEqual({ event_id: created.event_id, invitations: 0 });
    expect(await box.deleteEvent({ event_ids: [created.event_id] })).toMatchObject({ cancellations: 0 });
    expect(eventSets().map((s) => s.sendSchedulingMessages)).toEqual([false, false, true, false, false]);
    expect(await sendsCounted(stub)).toBe(1);
    expect(fake.schedulingMessages(A)).toEqual([{ kind: "REQUEST", eventId: created.event_id, attendees: [OK] }]);
  });

  it("a recurring event never counts as past", async () => {
    const { stub, box } = await signIn(A);
    const series = await box.createEvent({ ...invite, start: "2026-01-05T09:00:00Z", end: "2026-01-05T10:00:00Z", recurrence: { frequency: "weekly" } });
    expect(series.invitations).toBe(1);
    expect(await sendsCounted(stub)).toBe(1);
  });
});

describe("the notice decision", () => {
  const audience = (a: Partial<EventAudience> = {}): EventAudience => ({ attendees: [OK], end: T0 + DAY, recurring: false, ...a });

  it("create: participants and an end not in the past; a rule is never past; whole days get a day to spare", () => {
    expect(createNotice({ ...invite }, T0)).toEqual({ addresses: [OK], notify: true });
    expect(createNotice({ title: "x", ...FUTURE }, T0)).toEqual({ addresses: [], notify: false });
    expect(createNotice({ ...invite, start: "2027-01-15T06:00:00Z", end: "2027-01-15T07:59:59Z" }, T0).notify).toBe(false);
    expect(createNotice({ ...invite, start: "2027-01-15T06:00:00Z", end: "2027-01-15T08:00:00Z" }, T0).notify).toBe(true);
    const allDay = { title: "x", date: "2027-01-14", participants: [{ email: OK }] };
    expect(createNotice(allDay, T0).notify).toBe(true);
    expect(createNotice({ ...allDay, date: "2027-01-13" }, T0).notify).toBe(false);
    expect(createNotice({ ...allDay, date: "2027-01-13", days: 2 }, T0).notify).toBe(true);
    expect(createNotice({ ...allDay, date: "2027-01-12", days: 2 }, T0).notify).toBe(false);
    expect(createNotice({ ...invite, start: "2020-01-01T09:00:00Z", end: "2020-01-01T10:00:00Z", recurrence: { frequency: "daily", count: 1 } }, T0).notify).toBe(true);
    expect(createNotice({ title: "x", ...FUTURE, participants: [{ email: "A@B.example" }, { email: "c@d.example" }] }, T0).addresses).toEqual([
      "a@b.example",
      "c@d.example",
    ]);
  });

  it("update: the attendees before and after; the end after the update", () => {
    expect(updateNotice({ event_id: "e", title: "x" }, audience(), T0)).toEqual({ addresses: [OK], notify: true });
    expect(updateNotice({ event_id: "e", participants: [{ email: STRANGER }] }, audience(), T0)).toEqual({ addresses: [OK, STRANGER], notify: true });
    expect(updateNotice({ event_id: "e", participants: [] }, audience(), T0)).toEqual({ addresses: [OK], notify: true });
    expect(updateNotice({ event_id: "e", title: "x" }, audience({ attendees: [] }), T0)).toEqual({ addresses: [], notify: false });
    expect(updateNotice({ event_id: "e", title: "x" }, audience({ end: T0 - 1 }), T0).notify).toBe(false);
    expect(updateNotice({ event_id: "e", ...FUTURE }, audience({ end: T0 - 1 }), T0).notify).toBe(true);
    expect(updateNotice({ event_id: "e", start: "2020-01-01T09:00:00Z", end: "2020-01-01T10:00:00Z" }, audience(), T0).notify).toBe(false);
    expect(updateNotice({ event_id: "e", title: "x" }, audience({ end: T0 - 1, recurring: true }), T0).notify).toBe(true);
    expect(updateNotice({ event_id: "e", recurrence: null }, audience({ end: T0 - 1, recurring: true }), T0).notify).toBe(false);
    expect(updateNotice({ event_id: "e", recurrence: { frequency: "daily" } }, audience({ end: T0 - 1 }), T0).notify).toBe(true);
    expect(updateNotice({ event_id: "e", title: "x" }, audience({ end: null }), T0).notify).toBe(true);
  });

  it("delete: attendees and not past", () => {
    expect(deleteNotice(audience(), T0)).toEqual({ addresses: [OK], notify: true });
    expect(deleteNotice(audience({ attendees: [] }), T0).notify).toBe(false);
    expect(deleteNotice(audience({ end: T0 - 1 }), T0).notify).toBe(false);
    expect(deleteNotice(audience({ end: T0 - 1, recurring: true }), T0).notify).toBe(true);
  });

  it("the fingerprint: the operation and the input, participants in any order and case, never a mail's", async () => {
    const two = { ...invite, participants: [{ email: OK }, { email: STRANGER }] };
    const fp = await eventWriteFingerprint("create_event", two);
    expect(await eventWriteFingerprint("create_event", { ...two, participants: [{ email: STRANGER.toUpperCase() }, { email: OK }] })).toBe(fp);
    // Key order does not matter.
    expect(await eventWriteFingerprint("create_event", { participants: two.participants, end: two.end, start: two.start, title: two.title })).toBe(fp);
    expect(await eventWriteFingerprint("create_event", { ...two, title: "Other" })).not.toBe(fp);
    expect(await eventWriteFingerprint("update_event", two)).not.toBe(fp);
    expect(await eventWriteFingerprint("create_event", { ...two, participants: [{ email: OK, name: "Named" }, { email: STRANGER }] })).not.toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
