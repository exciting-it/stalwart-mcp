import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAIL_LIMITS, MailError, type MailErrorCode, type OutgoingMessage } from "../src/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import type { Env } from "../src/env";
import { JmapMailboxAdapter } from "../src/jmap/jmap-mailbox-adapter";
import { sendFingerprint, takeSend } from "../src/vault/limits";
import { type MailboxVault, vaultFor, WITH_ACCESS_TOKEN } from "../src/vault/mailbox-vault";
import { VaultMailbox } from "../src/vault/vault-mailbox";
import { createFakeStalwart, type FakeStalwart, type RecordedRequest } from "./fake-stalwart";

const ORIGIN = "https://mail-mcp.test.example";
const A = "a@test.example";
const B = "b@test.example";
/** The only recipient on the test SEND_ALLOWLIST. */
const OK = "ok@test.example";
/** In the future, so alarms scheduled from it never fire on their own during the test run. */
const T0 = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 86_400 * SECOND;

type Stub = DurableObjectStub<MailboxVault>;

let fake: FakeStalwart;
let now = T0;
let testNo = 0;

/**
 * Storage (vault rows, counters, recent sends) persists across the tests of this file, while each
 * fake numbers its account ids from 1. Filler mailboxes move every test's ids into a range of
 * its own, so no two tests share a vault.
 */
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

const msg: OutgoingMessage = { to: [OK], cc: [], bcc: [], subject: "Hello", body: "Hi there" };

/** Signs `email` in and returns its vault stub and the `VaultMailbox` the tools would use. */
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

/** Lets every upstream request take a while, so calls started together really overlap. */
function slowUpstream(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, 10));
    return fake.fetch(input, init);
  });
}

const submissions = (r: RecordedRequest): boolean => JSON.stringify(r.body ?? "").includes("EmailSubmission/set");

function sendsCounted(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (_v: MailboxVault, state) => {
    const row = state.storage.sql.exec("SELECT count FROM usage_counter WHERE name = 'send'").toArray()[0];
    return row ? Number(row.count) : 0;
  });
}

function recentSends(stub: Stub): Promise<Record<string, unknown>[]> {
  return runInDurableObject(stub, (_v: MailboxVault, state) =>
    state.storage.sql.exec("SELECT * FROM recent_sends").toArray(),
  );
}

/** Counts `n` sends for today directly in the vault's storage. */
function countSends(stub: Stub, n: number): Promise<void> {
  return runInDurableObject(stub, (_v: MailboxVault, state) => {
    for (let i = 0; i < n; i++) expect(takeSend(state.storage.sql, clock.now())).not.toBeNull();
  });
}

describe("send dedupe", () => {
  it("the same send twice produces exactly one submission and returns the first result", async () => {
    const { box } = await signIn(A);
    const r1 = await box.sendMail(msg);
    const r2 = await box.sendMail(msg);
    expect(fake.sent(A)).toHaveLength(1);
    expect(r1.deduplicated).toBe(false);
    expect(r2).toEqual({ ...r1, deduplicated: true });
  });

  it("two identical sends at the same time produce one submission", async () => {
    const { box } = await signIn(A);
    slowUpstream();
    const [r1, r2] = await Promise.all([box.sendMail(msg), box.sendMail(msg)]);
    expect(fake.sent(A)).toHaveLength(1);
    expect(r1.message_id).toBe(r2.message_id);
    expect([r1.deduplicated, r2.deduplicated].sort()).toEqual([false, true]);
  });

  it("sends again after 10 minutes", async () => {
    const { box } = await signIn(A);
    const r1 = await box.sendMail(msg);
    now += 599 * SECOND;
    expect(await box.sendMail(msg)).toEqual({ ...r1, deduplicated: true });
    now = T0 + 601 * SECOND;
    const r3 = await box.sendMail(msg);
    expect(r3.deduplicated).toBe(false);
    expect(r3.message_id).not.toBe(r1.message_id);
    expect(fake.sent(A)).toHaveLength(2);
  });

  it("recipient order and address case do not defeat the dedupe; a changed body does", async () => {
    const { box } = await signIn(A);
    await box.sendMail(msg);
    expect(await box.sendMail({ ...msg, to: ["OK@Test.Example"] })).toMatchObject({ deduplicated: true });
    expect(fake.sent(A)).toHaveLength(1);
    expect(await box.sendMail({ ...msg, body: "Hi there!" })).toMatchObject({ deduplicated: false });
    expect(fake.sent(A)).toHaveLength(2);

    // Order and case within each list do not matter; the list an address is in, and every text field, do.
    const two: OutgoingMessage = { ...msg, to: ["x@test.example", "y@test.example"] };
    const fp = await sendFingerprint(two);
    expect(await sendFingerprint({ ...two, to: ["Y@test.example", "x@TEST.example"] })).toBe(fp);
    expect(await sendFingerprint({ ...two, to: ["x@test.example"], cc: ["y@test.example"] })).not.toBe(fp);
    expect(await sendFingerprint({ ...two, bcc: ["z@test.example"] })).not.toBe(fp);
    expect(await sendFingerprint({ ...two, subject: "Hello!" })).not.toBe(fp);
    expect(await sendFingerprint({ ...two, in_reply_to: "m1" })).not.toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores only a hash, the time, the state, the message id and the recipient count of a send", async () => {
    const { stub, box } = await signIn(A);
    const r = await box.sendMail(msg);
    const rows = await recentSends(stub);
    expect(rows).toEqual([
      { fingerprint: await sendFingerprint(msg), sent_at: T0, state: "sent", message_id: r.message_id, recipients: 1 },
    ]);
    // Older rows are removed when the next send is recorded.
    now += 601 * SECOND;
    await box.sendMail({ ...msg, body: "later" });
    expect(await recentSends(stub)).toHaveLength(1);
  });
});

describe("send limit", () => {
  it("refuses message 51 of a UTC day and accepts again the next day", async () => {
    const { box } = await signIn(A);
    for (let i = 0; i < MAIL_LIMITS.sendsPerDay; i++) {
      expect(await box.sendMail({ ...msg, body: `message ${i}` })).toMatchObject({ deduplicated: false });
    }
    const before = fake.requests.length;
    await expectCode(box.sendMail({ ...msg, body: "one too many" }), "send_limit_reached");
    expect(fake.requests).toHaveLength(before);
    expect(fake.sent(A)).toHaveLength(MAIL_LIMITS.sendsPerDay);

    // The last millisecond of the same UTC day still counts against it.
    const nextDay = (Math.floor(T0 / DAY) + 1) * DAY;
    now = nextDay - 1;
    await expectCode(box.sendMail({ ...msg, body: "still today" }), "send_limit_reached");
    now = nextDay;
    expect(await box.sendMail({ ...msg, body: "one too many" })).toMatchObject({ deduplicated: false });
    expect(fake.sent(A)).toHaveLength(MAIL_LIMITS.sendsPerDay + 1);
  });

  it("a refused or definitely failed send is neither counted nor remembered, and may be sent again", async () => {
    const { stub, box } = await signIn(A);
    await expectCode(box.sendMail({ ...msg, to: ["stranger@test.example"] }), "recipient_not_allowed");
    await expectCode(box.sendMail({ ...msg, to: [] }), "invalid_input");

    fake.failNext("submission-rejected");
    await expectCode(box.sendMail(msg), "send_failed");
    expect(await sendsCounted(stub)).toBe(0);
    expect(await recentSends(stub)).toEqual([]);

    // A failure before the submit request (here: the folder and identity lookup) sent nothing.
    fake.failNext("http-503");
    await expectCode(box.sendMail(msg), "upstream_unavailable");
    expect(await sendsCounted(stub)).toBe(0);
    expect(await recentSends(stub)).toEqual([]);

    expect(await box.sendMail(msg)).toMatchObject({ deduplicated: false });
    expect(fake.sent(A)).toHaveLength(1);
    expect(await sendsCounted(stub)).toBe(1);
  });

  it("two different sends started together at 49 of 50 cannot both go out", async () => {
    const { stub, box } = await signIn(A);
    await countSends(stub, MAIL_LIMITS.sendsPerDay - 1);
    slowUpstream();
    const results = await Promise.allSettled([
      box.sendMail({ ...msg, body: "first" }),
      box.sendMail({ ...msg, body: "second" }),
    ]);
    expect(fake.sent(A)).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: "send_limit_reached" });
    expect(await sendsCounted(stub)).toBe(MAIL_LIMITS.sendsPerDay);
  });

  it("staging refuses a recipient outside SEND_ALLOWLIST before any upstream request", async () => {
    const { box } = await signIn(A);
    const n = fake.requests.length;
    await expect(box.sendMail({ ...msg, to: ["stranger@test.example"] })).rejects.toMatchObject({
      code: "recipient_not_allowed",
    });
    await expect(box.sendMail({ ...msg, bcc: ["stranger@test.example"] })).rejects.toMatchObject({
      code: "recipient_not_allowed",
    });
    expect(fake.requests).toHaveLength(n);
  });
});

describe("unconfirmed sends", () => {
  const submitRequests = () => fake.requests.filter(submissions);

  it("a 503 after the submission was accepted answers send_unconfirmed; an identical retry sends nothing", async () => {
    const { stub, box } = await signIn(A);
    fake.failNextSubmit("accepted-then-503");
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    const n = fake.requests.length;
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    expect(fake.requests).toHaveLength(n);
    expect(fake.sent(A)).toHaveLength(1);
    expect(await sendsCounted(stub)).toBe(1);
    expect(await recentSends(stub)).toEqual([
      { fingerprint: await sendFingerprint(msg), sent_at: T0, state: "unconfirmed", message_id: null, recipients: null },
    ]);
  });

  it("a network failure on the submit request is unconfirmed too: counted, and a retry does not send", async () => {
    const { stub, box } = await signIn(A);
    fake.failNextSubmit("network");
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    expect(fake.sent(A)).toHaveLength(0);
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    expect(submitRequests()).toHaveLength(1);
    expect(fake.sent(A)).toHaveLength(0);
    expect(await sendsCounted(stub)).toBe(1);
  });

  it("a pending send without an in-flight twin (the object restarted) answers send_unconfirmed", async () => {
    const { stub, box } = await signIn(A);
    const fingerprint = await sendFingerprint(msg);
    await runInDurableObject(stub, (_v: MailboxVault, state) => {
      state.storage.sql.exec(
        "INSERT INTO recent_sends (fingerprint, sent_at, state) VALUES (?, ?, 'pending')",
        fingerprint,
        clock.now() - 5 * SECOND,
      );
    });
    const n = fake.requests.length;
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    expect(fake.requests).toHaveLength(n);
    expect(await sendsCounted(stub)).toBe(0); // no new reservation
    // Another message is not affected.
    expect(await box.sendMail({ ...msg, body: "other" })).toMatchObject({ deduplicated: false });
  });

  it("an unconfirmed send blocks an identical one for exactly 600 s, then it goes out", async () => {
    const { stub, box } = await signIn(A);
    fake.failNextSubmit("accepted-then-503");
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    now = T0 + MAIL_LIMITS.sendDedupeSeconds * SECOND;
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    expect(fake.sent(A)).toHaveLength(1);
    now += SECOND;
    expect(await box.sendMail(msg)).toMatchObject({ deduplicated: false });
    expect(fake.sent(A)).toHaveLength(2);
    expect(await sendsCounted(stub)).toBe(2);
    // The old row was pruned by age; only the new, confirmed one is left.
    expect(await recentSends(stub)).toEqual([expect.objectContaining({ state: "sent", sent_at: now })]);
  });

  it("an in-flight twin of a send that fails definitively gets the same error and sends nothing", async () => {
    const { stub, box } = await signIn(A);
    slowUpstream();
    fake.failNext("submission-rejected");
    const results = await Promise.allSettled([box.sendMail(msg), box.sendMail(msg)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    for (const r of results) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "send_failed" });
    expect(submitRequests()).toHaveLength(1);
    expect(fake.sent(A)).toHaveLength(0);
    expect(await sendsCounted(stub)).toBe(0);
    expect(await recentSends(stub)).toEqual([]);
  });

  it("an in-flight twin of an unconfirmed send gets send_unconfirmed", async () => {
    const { box } = await signIn(A);
    slowUpstream();
    fake.failNextSubmit("accepted-then-503");
    const results = await Promise.allSettled([box.sendMail(msg), box.sendMail(msg)]);
    for (const r of results) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "send_unconfirmed" });
    expect(fake.sent(A)).toHaveLength(1);
  });

  it("a wipe keeps the unconfirmed row, so a reconnect does not reopen the send", async () => {
    const { stub, box, accountId } = await signIn(A);
    fake.failNextSubmit("accepted-then-503");
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    await stub.wipe("blocked");
    await stub.storeTokens({ accountId, email: A, origin: ORIGIN, ...fake.tokensFor(A) });
    await expectCode(box.sendMail(msg), "send_unconfirmed");
    expect(fake.sent(A)).toHaveLength(1);
  });

  it("the alarm prunes rows older than the dedupe window", async () => {
    const { stub } = await signIn(A);
    await runInDurableObject(stub, (_v: MailboxVault, state) => {
      const insert = "INSERT INTO recent_sends (fingerprint, sent_at, state) VALUES (?, ?, 'unconfirmed')";
      state.storage.sql.exec(insert, "old", T0 - 601 * SECOND);
      state.storage.sql.exec(insert, "young", T0 - 600 * SECOND);
    });
    await runInDurableObject(stub, (vault: MailboxVault) => vault.alarm());
    expect((await recentSends(stub)).map((r) => r.fingerprint)).toEqual(["young"]);
  });
});

describe("admission", () => {
  it("refuses tool call 61 within a minute and accepts again in the next minute", async () => {
    const { box } = await signIn(A);
    now = Math.floor(T0 / MINUTE) * MINUTE + 59 * SECOND;
    for (let i = 0; i < MAIL_LIMITS.toolCallsPerMinute; i++) await box.listMailboxes();
    const before = fake.requests.length;
    await expectCode(box.listMailboxes(), "rate_limited");
    await expectCode(box.sendMail(msg), "rate_limited");
    expect(fake.requests).toHaveLength(before);
    now += SECOND; // the next clock minute
    expect((await box.listMailboxes()).folders.length).toBeGreaterThan(0);
  });

  it("never runs more than 2 JMAP operations at once", async () => {
    const { box } = await signIn(A);
    await box.listMailboxes(); // session cached; from here on one request per search
    let inFlight = 0;
    let max = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      inFlight++;
      max = Math.max(max, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 10));
        return await fake.fetch(input, init);
      } finally {
        inFlight--;
      }
    });
    const before = fake.requests.length;
    const results = await Promise.all(Array.from({ length: 6 }, () => box.searchMail({ limit: 10, offset: 0 })));
    expect(results).toHaveLength(6);
    expect(fake.requests.length - before).toBe(6);
    expect(max).toBe(MAIL_LIMITS.upstreamConcurrency);
  });

  it("three operations that throw each release their upstream slot; a fourth succeeds", async () => {
    const { box } = await signIn(A);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(JmapMailboxAdapter.prototype, "listMailboxes");
    for (let i = 0; i < 3; i++) spy.mockRejectedValueOnce(new Error("boom"));
    const failed = await Promise.allSettled([box.listMailboxes(), box.listMailboxes(), box.listMailboxes()]);
    expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect((await box.listMailboxes()).folders.length).toBeGreaterThan(0);
  });

  it("refuses an operation for another account id than the stored one", async () => {
    const { stub } = await signIn(A);
    const other = fake.addMailbox(B).accountId;
    const before = fake.requests.length;
    expect(await stub.listMailboxes(other, A)).toEqual({ ok: false, code: "account_mismatch" });
    expect(await stub.sendMail(other, A, msg)).toEqual({ ok: false, code: "account_mismatch" });
    await expectCode(new VaultMailbox(env, other, B).listMailboxes(), "reconnect_required");
    expect(fake.requests).toHaveLength(before);
    expect(fake.sent(A)).toHaveLength(0);
  });

  it("refuses a grant whose address differs from the stored connection's; case does not matter", async () => {
    const { stub, accountId } = await signIn(A);
    const before = fake.requests.length;
    expect(await stub.listMailboxes(accountId, B)).toEqual({ ok: false, code: "account_mismatch" });
    expect(await stub.sendMail(accountId, "other@test.example", msg)).toEqual({ ok: false, code: "account_mismatch" });
    await expectCode(new VaultMailbox(env, accountId, B).searchMail({ limit: 10, offset: 0 }), "account_mismatch");
    expect(fake.requests).toHaveLength(before);
    expect(fake.sent(A)).toHaveLength(0);
    expect(await stub.listMailboxes(accountId, A.toUpperCase())).toMatchObject({ ok: true });
  });

  it("answers reconnect_required without counting or any upstream request when nothing is stored", async () => {
    const accountId = fake.addMailbox(A).accountId;
    expect(await vaultFor(env, accountId).searchMail(accountId, A, { limit: 10, offset: 0 })).toEqual({
      ok: false,
      code: "reconnect_required",
    });
    expect(fake.requests).toHaveLength(0);
    expect(await sendsCounted(vaultFor(env, accountId))).toBe(0);
  });

  it("validates every input again at the object's boundary", async () => {
    const { stub, accountId } = await signIn(A);
    const bad = <T>(v: unknown) => v as T;
    expect(await stub.searchMail(accountId, A, bad({ limit: 999 }))).toEqual({ ok: false, code: "invalid_input" });
    expect(await stub.readThread(accountId, A, bad({ thread_id: "../x" }))).toEqual({ ok: false, code: "invalid_input" });
    expect(await stub.createDraft(accountId, A, bad({ ...msg, subject: "a\r\nBcc: x@y.example" }))).toEqual({
      ok: false,
      code: "invalid_input",
    });
    // No recipient at all: invalid input, not an allowed (empty) recipient list.
    expect(await stub.sendMail(accountId, A, { ...msg, to: [] })).toEqual({ ok: false, code: "invalid_input" });
    expect(await stub.sendMail(accountId, A, bad({ ...msg, from: "boss@test.example" }))).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("an unexpected failure becomes internal and is logged by operation name only", async () => {
    const { box } = await signIn(A);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(JmapMailboxAdapter.prototype, "listMailboxes").mockRejectedValue(new Error("detail ok@test.example"));
    await expectCode(box.listMailboxes(), "internal");
    expect(log.mock.calls).toEqual([["vault_operation_failed", "listMailboxes"]]);
  });

  it("updates last_used_at after a successful operation", async () => {
    const { stub, box } = await signIn(A);
    now += 5 * MINUTE;
    await box.listMailboxes();
    expect(await stub.status()).toMatchObject({ lastUsedAt: now });
  });
});

describe("isolation", () => {
  it("mailbox A's vault never sends mailbox B's token or account id upstream", async () => {
    const a = await signIn(A);
    const b = await signIn(B);
    const tokenB = fake.tokensFor(B).accessToken;
    const tokenA = fake.tokensFor(A).accessToken;
    const { threadId } = fake.addMessage(A, { subject: "Question" });
    const before = fake.requests.length;

    await a.box.listMailboxes();
    await a.box.searchMail({ limit: 10, offset: 0 });
    await a.box.readThread({ thread_id: threadId });
    await a.box.createDraft({ ...msg, to: [B] });
    await a.box.sendMail(msg);

    const made = fake.requests.slice(before);
    expect(made.length).toBeGreaterThan(5);
    for (const r of made) {
      expect(r.authorization).toBe(`Bearer ${tokenA}`);
      const body = JSON.stringify(r.body ?? "");
      expect(body).not.toContain(tokenB);
      const calls = (r.body as { methodCalls?: [string, { accountId: string }, string][] } | null)?.methodCalls ?? [];
      for (const [, args] of calls) expect(args.accountId).toBe(a.accountId);
      expect(body).not.toContain(`"accountId":"${b.accountId}"`);
    }
    expect(fake.sent(B)).toHaveLength(0);
  });
});

describe("token door", () => {
  const RPC_SURFACE = [
    "alarm",
    "confirmGrant",
    "createDraft",
    "listMailboxes",
    "readThread",
    "searchMail",
    "sendMail",
    "status",
    "storeTokens",
    "wipe",
  ];

  it("the only public methods of the vault are its RPC surface", async () => {
    const { MailboxVault } = await import("../src/vault/mailbox-vault");
    const names = Object.getOwnPropertyNames(MailboxVault.prototype).filter((n) => n !== "constructor");
    expect(names.sort()).toEqual(RPC_SURFACE);
    expect(Object.getOwnPropertySymbols(MailboxVault.prototype)).toEqual([WITH_ACCESS_TOKEN]);
  });

  it("no call over the stub hands out a token", async () => {
    const { stub } = await signIn(A);
    const token = fake.tokensFor(A).accessToken;
    const leaked: unknown[] = [];
    const remote = stub as unknown as Record<string | symbol, (...args: unknown[]) => Promise<unknown>>;
    const attempts = [
      () => remote.withAccessToken!(async (t: unknown) => leaked.push(t)),
      () => remote[WITH_ACCESS_TOKEN]!(async (t: unknown) => leaked.push(t)),
      // Formerly TS-private; now `#`-private, so not on the prototype either.
      () => remote.accessToken!(),
    ];
    for (const attempt of attempts) {
      const outcome = await Promise.resolve()
        .then(attempt)
        .then(
          (v) => ({ ok: true, v }),
          () => ({ ok: false }),
        );
      expect(outcome.ok).toBe(false);
    }
    expect(leaked).toEqual([]);
    expect(JSON.stringify(await stub.status())).not.toContain(token);
  });
});

describe("VaultMailbox", () => {
  const envWith = (answer: () => Promise<unknown>): Env =>
    ({
      MAILBOX_VAULT: {
        idFromName: () => ({}),
        get: () => new Proxy({}, { get: () => answer }),
      },
    }) as unknown as Env;

  it("turns a failed or malformed RPC answer into internal", async () => {
    await expectCode(new VaultMailbox(envWith(() => Promise.reject(new Error("gone"))), "1", A).listMailboxes(), "internal");
    await expectCode(new VaultMailbox(envWith(async () => ({ value: 1 })), "1", A).listMailboxes(), "internal");
    await expectCode(new VaultMailbox(envWith(async () => ({ ok: false, code: "nope" })), "1", A).sendMail(msg), "internal");
    await expectCode(new VaultMailbox(envWith(async () => undefined), "1", A).readThread({ thread_id: "t" }), "internal");
  });

  it("throws the code of a failed operation and returns the value of a successful one", async () => {
    await expectCode(
      new VaultMailbox(envWith(async () => ({ ok: false, code: "send_limit_reached" })), "1", A).sendMail(msg),
      "send_limit_reached",
    );
    const value = { draft_id: "d1", folder_id: "f1" };
    expect(await new VaultMailbox(envWith(async () => ({ ok: true, value })), "1", A).createDraft(msg)).toEqual(value);
  });
});
