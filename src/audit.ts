import { MAIL_LIMITS } from "./mail";
import { clock } from "./clock";

export type AuditEvent =
  | "sign_in"
  | "sign_in_refused"
  | "approval_allowed"
  | "approval_denied"
  | "tool_call"
  | "upstream_revoked"
  | "connection_wiped";

// No field here can hold a subject, body, search term or recipient address.
export interface AuditEntry {
  event: AuditEvent;
  outcome: "ok" | "refused" | "error";
  accountId?: string;
  email?: string;
  clientId?: string;
  clientName?: string;
  tool?: string;
  errorCode?: string;
  resultCount?: number;
  recipientCount?: number;
  messageId?: string;
}

const AUDIT_RETENTION_SECONDS = MAIL_LIMITS.auditRetentionDays * 86_400;
const PENDING_APPROVAL_TTL_SECONDS = 3600;

const nowSeconds = (): number => Math.floor(clock.now() / 1000);

/** Never throws. A failed write logs a fixed marker only, never the entry or the error. */
export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log
          (at, event, account_id, email, client_id, client_name, tool, outcome, error_code, result_count, recipient_count, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        nowSeconds(),
        entry.event,
        entry.accountId ?? null,
        entry.email ?? null,
        entry.clientId ?? null,
        entry.clientName ?? null,
        entry.tool ?? null,
        entry.outcome,
        entry.errorCode ?? null,
        entry.resultCount ?? null,
        entry.recipientCount ?? null,
        entry.messageId ?? null,
      )
      .run();
  } catch {
    console.error("audit_write_failed");
  }
}

/** Removes audit rows older than 90 days and pending approvals older than one hour. */
export async function purgeAudit(db: D1Database): Promise<void> {
  const now = nowSeconds();
  await db.batch([
    db.prepare("DELETE FROM audit_log WHERE at < ?").bind(now - AUDIT_RETENTION_SECONDS),
    db.prepare("DELETE FROM pending_approvals WHERE created_at < ?").bind(now - PENDING_APPROVAL_TTL_SECONDS),
  ]);
}

/** A block row's key is either an account id (exact) or an address (any case). */
export async function isBlocked(db: D1Database, who: { accountId: string; email: string }): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM blocked_accounts WHERE key = ? OR lower(key) = ? LIMIT 1")
    .bind(who.accountId, who.email.toLowerCase())
    .first();
  return row !== null;
}
