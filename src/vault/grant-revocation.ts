/**
 * Worker grants a wipe still has to revoke, in the vault's SQLite storage (one row at most).
 * A wipe that ends a connection for good (`upstream_revoked`, `idle`, `blocked`) revokes the
 * mailbox's Worker grants. When that fails the row says `retry`; when it succeeded the row says
 * `follow_up`, because a grant created moments earlier may not be listed by KV yet. The vault's
 * alarm runs the revocation again and clears the row; a new sign-in clears it too, since it
 * revokes every grant of a mailbox without a connection itself.
 */
export type RevocationKind = "retry" | "follow_up";

export interface PendingRevocation {
  accountId: string;
  /** The Worker origin the grants were issued through (to reach the grant directory). */
  origin: string;
  kind: RevocationKind;
  /** No retry after this time (epoch milliseconds). */
  giveUpAt: number;
}

interface RevocationRow extends Record<string, SqlStorageValue> {
  account_id: string;
  origin: string;
  kind: string;
  give_up_at: number;
}

export function ensureRevocationSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS pending_grant_revocation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('retry', 'follow_up')),
    give_up_at INTEGER NOT NULL
  )`);
}

export function readRevocation(sql: SqlStorage): PendingRevocation | null {
  const row = sql.exec<RevocationRow>("SELECT * FROM pending_grant_revocation WHERE id = 1").toArray()[0];
  if (!row) return null;
  return {
    accountId: row.account_id,
    origin: row.origin,
    kind: row.kind === "follow_up" ? "follow_up" : "retry",
    giveUpAt: row.give_up_at,
  };
}

export function writeRevocation(sql: SqlStorage, r: PendingRevocation): void {
  sql.exec(
    `INSERT OR REPLACE INTO pending_grant_revocation (id, account_id, origin, kind, give_up_at)
     VALUES (1, ?, ?, ?, ?)`,
    r.accountId,
    r.origin,
    r.kind,
    r.giveUpAt,
  );
}

export function clearRevocation(sql: SqlStorage): void {
  sql.exec("DELETE FROM pending_grant_revocation");
}
