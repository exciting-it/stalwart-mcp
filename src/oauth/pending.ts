/**
 * Sign-ins waiting for Allow or Deny on our approval page, keyed by the consent handle. Only
 * the SHA-256 of the handle is stored: reading the table cannot recreate a usable handle.
 */
import { MAIL_LIMITS } from "../mail";
import { clock } from "../clock";

export interface PendingApproval {
  accountId: string;
  email: string;
  clientId: string;
  clientName: string;
  redirectHost: string;
  /** Epoch seconds. */
  createdAt: number;
}

interface PendingRow {
  account_id: string;
  email: string;
  client_id: string;
  client_name: string;
  redirect_host: string;
  created_at: number;
}

const nowSeconds = (): number => Math.floor(clock.now() / 1000);

async function handleHash(handle: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(handle));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A row older than the abandoned-sign-in window counts as absent. */
function fresh(row: PendingRow | null): PendingApproval | null {
  if (!row || nowSeconds() - row.created_at > MAIL_LIMITS.abandonedSignInSeconds) return null;
  return {
    accountId: row.account_id,
    email: row.email,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectHost: row.redirect_host,
    createdAt: row.created_at,
  };
}

export async function putPending(
  db: D1Database,
  handle: string,
  p: { accountId: string; email: string; clientId: string; clientName: string; redirectHost: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_approvals (handle_hash, account_id, email, client_id, client_name, redirect_host, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(await handleHash(handle), p.accountId, p.email, p.clientId, p.clientName, p.redirectHost, nowSeconds())
    .run();
}

/** Removes the row in the same statement that reads it, so a handle yields its row at most once. */
export async function takePending(db: D1Database, handle: string): Promise<PendingApproval | null> {
  const row = await db
    .prepare("DELETE FROM pending_approvals WHERE handle_hash = ? RETURNING *")
    .bind(await handleHash(handle))
    .first<PendingRow>();
  return fresh(row);
}

export async function peekPending(db: D1Database, handle: string): Promise<PendingApproval | null> {
  const row = await db
    .prepare("SELECT * FROM pending_approvals WHERE handle_hash = ?")
    .bind(await handleHash(handle))
    .first<PendingRow>();
  return fresh(row);
}
