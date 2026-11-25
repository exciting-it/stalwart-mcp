/**
 * The vault's SQLite storage: one `connection` row per Durable Object (one mailbox) with the
 * Stalwart tokens sealed by `crypto.ts`. Clear tokens leave this file only as return values to
 * the vault; a key or decryption failure is `MailError("internal")` without detail.
 */
import { MailError } from "../mail";
import type { UpstreamTokens } from "../stalwart/oauth-client";
import { decryptSecret, encryptSecret, type SecretBox } from "./crypto";

/** A stored connection. Times are epoch milliseconds. */
export interface Connection {
  accountId: string;
  email: string;
  /** The Worker's own origin at sign-in, needed to reach its grant directory. */
  origin: string;
  accessBox: SecretBox;
  refreshBox: SecretBox;
  accessExpiresAt: number;
  connectedAt: number;
  lastUsedAt: number;
  /** No refresh attempt before this time (0: none pending). */
  refreshBlockedUntil: number;
  /**
   * A random id per sign-in, never reused (also not after a wipe), so a decision taken before an
   * `await` can confirm afterwards that it still concerns the same connection.
   */
  generation: string;
}

interface ConnectionRow extends Record<string, SqlStorageValue> {
  account_id: string;
  email: string;
  origin: string;
  access_box: string;
  refresh_box: string;
  access_expires_at: number;
  connected_at: number;
  last_used_at: number;
  refresh_blocked_until: number;
  generation: string;
}

export function ensureSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_id TEXT NOT NULL,
    email TEXT NOT NULL,
    origin TEXT NOT NULL,
    access_box TEXT NOT NULL,
    refresh_box TEXT NOT NULL,
    access_expires_at INTEGER NOT NULL,
    connected_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    refresh_blocked_until INTEGER NOT NULL DEFAULT 0,
    generation TEXT NOT NULL
  )`);
}

export function readConnection(sql: SqlStorage): Connection | null {
  const row = sql.exec<ConnectionRow>("SELECT * FROM connection WHERE id = 1").toArray()[0];
  if (!row) return null;
  return {
    accountId: row.account_id,
    email: row.email,
    origin: row.origin,
    accessBox: JSON.parse(row.access_box) as SecretBox,
    refreshBox: JSON.parse(row.refresh_box) as SecretBox,
    accessExpiresAt: row.access_expires_at,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
    refreshBlockedUntil: row.refresh_blocked_until,
    generation: row.generation,
  };
}

/** Inserts or replaces the connection with a new generation; a replacement keeps `connected_at`. */
export function writeConnection(
  sql: SqlStorage,
  c: Omit<Connection, "connectedAt" | "refreshBlockedUntil" | "generation"> & { now: number },
): void {
  sql.exec(
    `INSERT INTO connection
       (id, account_id, email, origin, access_box, refresh_box, access_expires_at, connected_at, last_used_at,
        generation)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       email = excluded.email, origin = excluded.origin,
       access_box = excluded.access_box, refresh_box = excluded.refresh_box,
       access_expires_at = excluded.access_expires_at, last_used_at = excluded.last_used_at,
       refresh_blocked_until = 0, generation = excluded.generation`,
    c.accountId,
    c.email,
    c.origin,
    JSON.stringify(c.accessBox),
    JSON.stringify(c.refreshBox),
    c.accessExpiresAt,
    c.now,
    c.lastUsedAt,
    crypto.randomUUID(),
  );
}

/** Stores refreshed tokens unless the row was replaced or deleted meanwhile; true when stored. */
export function updateTokens(
  sql: SqlStorage,
  generation: string,
  t: { accessBox: SecretBox; refreshBox: SecretBox; accessExpiresAt: number },
): boolean {
  const cursor = sql.exec(
    `UPDATE connection SET access_box = ?, refresh_box = ?, access_expires_at = ?, refresh_blocked_until = 0
     WHERE id = 1 AND generation = ?`,
    JSON.stringify(t.accessBox),
    JSON.stringify(t.refreshBox),
    t.accessExpiresAt,
    generation,
  );
  return cursor.rowsWritten > 0;
}

export function blockRefreshUntil(sql: SqlStorage, generation: string, until: number): void {
  sql.exec("UPDATE connection SET refresh_blocked_until = ? WHERE id = 1 AND generation = ?", until, generation);
}

export function touchLastUsed(sql: SqlStorage, now: number): void {
  sql.exec("UPDATE connection SET last_used_at = ? WHERE id = 1", now);
}

export function deleteConnection(sql: SqlStorage): void {
  sql.exec("DELETE FROM connection");
}

/** Seals both tokens; the account id is the additional authenticated data. */
export async function sealTokens(
  key: string,
  accountId: string,
  tokens: Pick<UpstreamTokens, "accessToken" | "refreshToken">,
): Promise<{ accessBox: SecretBox; refreshBox: SecretBox }> {
  try {
    return {
      accessBox: await encryptSecret(key, tokens.accessToken, accountId),
      refreshBox: await encryptSecret(key, tokens.refreshToken, accountId),
    };
  } catch {
    throw new MailError("internal");
  }
}

export async function openToken(key: string, accountId: string, box: SecretBox): Promise<string> {
  try {
    return await decryptSecret(key, box, accountId);
  } catch {
    throw new MailError("internal");
  }
}
