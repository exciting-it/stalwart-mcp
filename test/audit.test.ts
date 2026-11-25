import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import { isBlocked, purgeAudit, writeAudit } from "../src/audit";

const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const DAY = 86400;

interface AuditRow {
  at: number;
  event: string;
  account_id: string | null;
  email: string | null;
  client_id: string | null;
  client_name: string | null;
  tool: string | null;
  outcome: string;
  error_code: string | null;
  result_count: number | null;
  recipient_count: number | null;
  message_id: string | null;
}

async function auditRows(): Promise<AuditRow[]> {
  return (await env.DB.prepare("SELECT * FROM audit_log ORDER BY id").all<AuditRow>()).results;
}

async function insertAuditAt(at: number): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (at, event, outcome) VALUES (?, 'tool_call', 'ok')").bind(at).run();
}

async function insertPendingAt(hash: string, createdAt: number): Promise<void> {
  await env.DB.prepare("INSERT INTO pending_approvals VALUES (?, 'a', 'a@test.example', 'c', 'C', 'h.example', ?)")
    .bind(hash, createdAt)
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_log"),
    env.DB.prepare("DELETE FROM blocked_accounts"),
    env.DB.prepare("DELETE FROM pending_approvals"),
  ]);
  vi.spyOn(clock, "now").mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeAudit", () => {
  it("writes one row with the given columns and the clock's time", async () => {
    await writeAudit(env.DB, {
      event: "tool_call",
      outcome: "ok",
      accountId: "acc1",
      email: "u@test.example",
      clientId: "cl1",
      clientName: "Client",
      tool: "search_mail",
      errorCode: "E1",
      resultCount: 3,
      recipientCount: 2,
      messageId: "m1",
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      at: NOW_S,
      event: "tool_call",
      outcome: "ok",
      account_id: "acc1",
      email: "u@test.example",
      client_id: "cl1",
      client_name: "Client",
      tool: "search_mail",
      error_code: "E1",
      result_count: 3,
      recipient_count: 2,
      message_id: "m1",
    });
  });

  it("stores omitted fields as NULL", async () => {
    await writeAudit(env.DB, { event: "sign_in_refused", outcome: "refused" });
    const [row] = await auditRows();
    expect(row).toMatchObject({
      at: NOW_S,
      event: "sign_in_refused",
      outcome: "refused",
      account_id: null,
      email: null,
      client_id: null,
      client_name: null,
      tool: null,
      error_code: null,
      result_count: null,
      recipient_count: null,
      message_id: null,
    });
  });

  it("stores a hostile string verbatim and leaves the table intact", async () => {
    const hostile = "x'); DROP TABLE audit_log;--";
    await writeAudit(env.DB, { event: "sign_in", outcome: "ok", email: hostile });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe(hostile);
  });

  it("does not throw when the insert fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      writeAudit(
        {
          prepare: () => {
            throw new Error("boom");
          },
        } as never,
        { event: "tool_call", outcome: "ok" },
      ),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toEqual(["audit_write_failed"]);
  });

  it("does not throw when the insert rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("secret detail")) }) }),
    };
    await expect(writeAudit(db as never, { event: "tool_call", outcome: "ok" })).resolves.toBeUndefined();
    expect(errorSpy.mock.calls).toEqual([["audit_write_failed"]]);
  });
});

describe("purgeAudit", () => {
  it("deletes audit rows older than 90 days and keeps newer ones", async () => {
    await insertAuditAt(NOW_S - 91 * DAY);
    await insertAuditAt(NOW_S - 89 * DAY);
    await purgeAudit(env.DB);
    expect((await auditRows()).map((r) => r.at)).toEqual([NOW_S - 89 * DAY]);
  });

  it("keeps an audit row exactly 90 days old and deletes one second older", async () => {
    await insertAuditAt(NOW_S - 90 * DAY);
    await insertAuditAt(NOW_S - 90 * DAY - 1);
    await purgeAudit(env.DB);
    expect((await auditRows()).map((r) => r.at)).toEqual([NOW_S - 90 * DAY]);
  });

  it("deletes pending approvals older than one hour", async () => {
    await insertPendingAt("old", NOW_S - 3601);
    await insertPendingAt("edge", NOW_S - 3600);
    await insertPendingAt("fresh", NOW_S - 3599);
    await purgeAudit(env.DB);
    const rows = (await env.DB.prepare("SELECT handle_hash FROM pending_approvals ORDER BY handle_hash").all<{
      handle_hash: string;
    }>()).results;
    expect(rows.map((r) => r.handle_hash)).toEqual(["edge", "fresh"]);
  });

  it("leaves the block list alone", async () => {
    await env.DB.prepare("INSERT INTO blocked_accounts VALUES ('x@test.example','abuse',0)").run();
    await purgeAudit(env.DB);
    expect(await isBlocked(env.DB, { accountId: "q1", email: "x@test.example" })).toBe(true);
  });
});

describe("isBlocked", () => {
  it("blocks by address, case-insensitively", async () => {
    await env.DB.prepare("INSERT INTO blocked_accounts VALUES ('x@test.example','abuse',0)").run();
    expect(await isBlocked(env.DB, { accountId: "q1", email: "X@Test.example" })).toBe(true);
    expect(await isBlocked(env.DB, { accountId: "q1", email: "y@test.example" })).toBe(false);
  });

  it("blocks by account id", async () => {
    await env.DB.prepare("INSERT INTO blocked_accounts VALUES ('acc-77','abuse',0)").run();
    expect(await isBlocked(env.DB, { accountId: "acc-77", email: "someone@test.example" })).toBe(true);
    expect(await isBlocked(env.DB, { accountId: "acc-78", email: "someone@test.example" })).toBe(false);
  });

  it("blocks by an address row written with upper-case letters", async () => {
    await env.DB.prepare("INSERT INTO blocked_accounts VALUES ('Upper@Test.Example','abuse',0)").run();
    expect(await isBlocked(env.DB, { accountId: "q2", email: "upper@test.example" })).toBe(true);
    expect(await isBlocked(env.DB, { accountId: "q2", email: "UPPER@TEST.EXAMPLE" })).toBe(true);
  });

  it("treats a hostile address as data", async () => {
    expect(await isBlocked(env.DB, { accountId: "q1", email: "' OR '1'='1" })).toBe(false);
  });
});
