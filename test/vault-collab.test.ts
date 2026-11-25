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
      { op: "delete_contact", input: { contact_id: "ct1" } },
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
    ["", "contacts", "not_granted"],
    ["", "calendars", "not_granted"],
    ["contacts", "calendars", "not_granted"],
    ["calendars", "contacts", "not_granted"],
  ])("FEATURES=%j: %s is %s", async (features, area, expected) => {
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
        env: { ...env, FEATURES: features } as Env,
        withAccessToken: (fn) => vault[WITH_ACCESS_TOKEN](fn),
      });
      return Promise.all(requests.map((r) => ops.collab(caller(email, accountId), r)));
    });
    for (const answer of answers) expect(answer).toEqual({ ok: false, code: expected });
    expect(jmapPosts().length).toBe(before);
  });

  it("serves the area that is switched on", async () => {
    const { stub, accountId } = await signIn(A);
    fake.addContact(A, { name: { full: "Ada" } });
    const answer = await runInDurableObject(stub, (vault: MailboxVault, state) =>
      new MailboxOperations({
        sql: state.storage.sql,
        env: { ...env, FEATURES: "contacts" } as Env,
        withAccessToken: (fn) => vault[WITH_ACCESS_TOKEN](fn),
      }).collab(caller(A, accountId), { op: "search_contacts", input: { limit: 10, offset: 0 } }),
    );
    expect(answer).toMatchObject({ ok: true, value: { contacts: [{ name: "Ada" }] } });
  });

  it("treats an invalid FEATURES setting as no area", async () => {
    const { stub, accountId } = await signIn(A);
    const answer = await runInDurableObject(stub, (vault: MailboxVault, state) =>
      new MailboxOperations({
        sql: state.storage.sql,
        env: { ...env, FEATURES: "contacts,files" } as Env,
        withAccessToken: (fn) => vault[WITH_ACCESS_TOKEN](fn),
      }).collab(caller(A, accountId), { op: "search_contacts", input: { limit: 10, offset: 0 } }),
    );
    expect(answer).toEqual({ ok: false, code: "not_granted" });
  });
});
