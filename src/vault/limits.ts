/**
 * Per-mailbox limits in the vault's SQLite storage: the tool-call counter per clock minute, the
 * send counter per UTC day, and the recent sends used to drop a repeated send. All access is
 * synchronous SQL, so a check and its increment can never interleave with another call.
 *
 * Event writes that make the mail server notify people (invitations, updates, cancellations)
 * count as sends: the same counter, and for a notifying create, update or answer the same
 * `recent_sends` rows. Such a row's `message_id` holds the event id (`<event id>/<calendar id>`
 * for a create) and `recipients` the number of people notified. An answer's row lives only while
 * it is pending or unconfirmed: once confirmed it is deleted, because the stored answer, not the
 * window, says whether a repeat changes anything.
 *
 * `recent_sends` holds only a SHA-256 of the message, the time, the state of the send and, once
 * it is confirmed, the message id and the recipient count: no address, subject or body is
 * stored. A send is `pending` from its reservation until Stalwart answers, `sent` once it
 * confirmed, and `unconfirmed` when its outcome is unknown (the mail may have gone out). The rows
 * outlive a wipe of the connection, so a reconnect never reopens a send of the last 10 minutes.
 */
import { MAIL_LIMITS, type OutgoingMessage } from "../mail";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DEDUPE_MS = MAIL_LIMITS.sendDedupeSeconds * 1000;

export function ensureLimitsSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS usage_counter (
    name TEXT PRIMARY KEY,
    period INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS recent_sends (
    fingerprint TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'unconfirmed')),
    message_id TEXT,
    recipients INTEGER
  )`);
}

interface CounterRow extends Record<string, SqlStorageValue> {
  period: number;
  count: number;
}

/** Counts `amount` uses of `name` in `period` unless that would go beyond `limit` uses there. */
function take(sql: SqlStorage, name: string, period: number, limit: number, amount = 1): boolean {
  const row = sql.exec<CounterRow>("SELECT period, count FROM usage_counter WHERE name = ?", name).toArray()[0];
  const used = row && row.period === period ? row.count : 0;
  if (used + amount > limit) return false;
  sql.exec(
    `INSERT INTO usage_counter (name, period, count) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET period = excluded.period, count = excluded.count`,
    name,
    period,
    used + amount,
  );
  return true;
}

/** Counts one tool call in the clock minute of `now`; false for call 61 within that minute. */
export function takeToolCall(sql: SqlStorage, now: number): boolean {
  return take(sql, "tool_call", Math.floor(now / MINUTE_MS), MAIL_LIMITS.toolCallsPerMinute);
}

export interface RecordedSend {
  message_id: string;
  recipients: number;
}

/** What `recent_sends` knows about a fingerprint within the dedupe window. */
export type RecentSend = { state: "sent"; sent: RecordedSend } | { state: "pending" | "unconfirmed" };

interface RecentSendRow extends Record<string, SqlStorageValue> {
  state: string;
  message_id: string | null;
  recipients: number | null;
}

/** Drops the rows older than the dedupe window. */
export function pruneRecentSends(sql: SqlStorage, now: number): void {
  sql.exec("DELETE FROM recent_sends WHERE sent_at < ?", now - DEDUPE_MS);
}

/** The send with this fingerprint from the last `sendDedupeSeconds`, if any. */
export function findRecentSend(sql: SqlStorage, fingerprint: string, now: number): RecentSend | null {
  const row = sql
    .exec<RecentSendRow>(
      "SELECT state, message_id, recipients FROM recent_sends WHERE fingerprint = ? AND sent_at >= ?",
      fingerprint,
      now - DEDUPE_MS,
    )
    .toArray()[0];
  if (!row) return null;
  if (row.state === "sent" && row.message_id !== null && row.recipients !== null) {
    return { state: "sent", sent: { message_id: row.message_id, recipients: row.recipients } };
  }
  return { state: row.state === "pending" ? "pending" : "unconfirmed" };
}

/**
 * Reserves `sends` sends (one, unless a notifying event write involves more than ten people) in the
 * UTC day of `now` and records them as `pending`, in one synchronous step. Returns that day (to
 * release the reservation with) or null when fewer are left.
 */
export function reserveSend(sql: SqlStorage, fingerprint: string, now: number, sends = 1): number | null {
  const day = takeSends(sql, now, sends);
  if (day === null) return null;
  sql.exec(
    "INSERT OR REPLACE INTO recent_sends (fingerprint, sent_at, state, message_id, recipients) VALUES (?, ?, 'pending', NULL, NULL)",
    fingerprint,
    now,
  );
  return day;
}

/** Stalwart confirmed the send: the row answers identical sends with this result. */
export function confirmSend(sql: SqlStorage, fingerprint: string, sent: RecordedSend): void {
  sql.exec(
    "UPDATE recent_sends SET state = 'sent', message_id = ?, recipients = ? WHERE fingerprint = ?",
    sent.message_id,
    sent.recipients,
    fingerprint,
  );
}

/**
 * Stalwart confirmed a send whose result must never answer a later call (an answer to an
 * invitation): the row goes, the counted send stays.
 */
export function forgetSend(sql: SqlStorage, fingerprint: string): void {
  sql.exec("DELETE FROM recent_sends WHERE fingerprint = ?", fingerprint);
}

/** The outcome is unknown: the row and the day's reservation both stay. */
export function markSendUnconfirmed(sql: SqlStorage, fingerprint: string): void {
  sql.exec("UPDATE recent_sends SET state = 'unconfirmed' WHERE fingerprint = ?", fingerprint);
}

/** The send definitely did not go out: forget it and give its reservation (`sends`) back. */
export function dropSend(sql: SqlStorage, fingerprint: string, day: number, sends = 1): void {
  sql.exec("DELETE FROM recent_sends WHERE fingerprint = ?", fingerprint);
  releaseSends(sql, day, sends);
}

/** Reserves one send in the UTC day of `now`; null when the day's sends are used up. */
export function takeSend(sql: SqlStorage, now: number): number | null {
  const day = Math.floor(now / DAY_MS);
  return take(sql, "send", day, MAIL_LIMITS.sendsPerDay) ? day : null;
}

/**
 * Reserves `n` sends at once in the UTC day of `now` (a `delete_event` that cancels `n` events):
 * all of them, or none and null when fewer are left.
 */
export function takeSends(sql: SqlStorage, now: number, n: number): number | null {
  const day = Math.floor(now / DAY_MS);
  return take(sql, "send", day, MAIL_LIMITS.sendsPerDay, n) ? day : null;
}

/** Gives back `n` sends reserved for `day` that did not go out. */
export function releaseSends(sql: SqlStorage, day: number, n: number): void {
  if (n <= 0) return;
  sql.exec("UPDATE usage_counter SET count = MAX(count - ?, 0) WHERE name = 'send' AND period = ?", n, day);
}

const normalized = (list: string[]): string[] => list.map((a) => a.toLowerCase()).sort();

/**
 * SHA-256 (hex) over the lower-cased, sorted `to`, `cc` and `bcc` lists (each separately),
 * `subject`, `body` and `in_reply_to`: what makes two sends the same message.
 */
export async function sendFingerprint(m: OutgoingMessage): Promise<string> {
  const canonical = JSON.stringify([
    normalized(m.to),
    normalized(m.cc),
    normalized(m.bcc),
    m.subject ?? null,
    m.body,
    m.in_reply_to ?? null,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keys sorted at every level, so two equal inputs always serialize alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
  );
}

/**
 * SHA-256 (hex) over the operation and its validated input, with keys sorted and participants
 * compared by lower-cased address in any order: what makes two notifying event writes the same.
 * It starts with the operation's name, so it never equals the fingerprint of a mail.
 */
export async function eventWriteFingerprint(
  op: "create_event" | "update_event" | "respond_to_event",
  input: { participants?: { email: string; name?: string }[] } & Record<string, unknown>,
): Promise<string> {
  const participants = input.participants
    ?.map((p) => ({ ...p, email: p.email.toLowerCase() }))
    .sort((a, b) => a.email.localeCompare(b.email));
  const text = JSON.stringify([op, canonical({ ...input, ...(participants ? { participants } : {}) })]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
