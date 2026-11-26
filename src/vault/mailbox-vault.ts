/**
 * One Durable Object per Stalwart account id: the only place that holds and refreshes that
 * mailbox's Stalwart tokens. Stalwart rotates the refresh token on every use and ends the whole
 * grant when a superseded one is presented, so a second holder would cut the mailbox off.
 *
 * Clear tokens exist only in local variables here. They never appear in a return value of an
 * RPC method, an error, a log line or an audit row.
 *
 * Every public method is reachable over Durable Object RPC, so the class has no public method
 * other than its RPC surface. Everything else is a JS-private (`#`) member, and the token door
 * is keyed by the module's `WITH_ACCESS_TOKEN` symbol: RPC addresses methods by string name
 * only, so a stub can never reach it.
 */
import { DurableObject } from "cloudflare:workers";
import type { CollabRequestT, CollabValue } from "../collab";
import {
  type AttachmentDelivery,
  MAIL_LIMITS,
  MailError,
  type MailFolder,
  type MailSummary,
  type MarkMailInputT,
  type MarkMailOutcome,
  type MoveMailOutcome,
  type MoveMailRequestT,
  type OutgoingMessage,
  type ReadAttachmentInputT,
  type ReadThreadInputT,
  type SearchMailInputT,
  type ThreadMessage,
} from "../mail";
import { writeAudit } from "../audit";
import { clock } from "../clock";
import { dataJurisdiction } from "../config";
import type { Env } from "../env";
import { fetchSession, type JmapSession, UpstreamAuthError } from "../jmap/jmap-client";
import { grantDirectory } from "../oauth/options";
import { InvalidGrantError, refreshTokens, revokeToken, type UpstreamTokens } from "../stalwart/oauth-client";
import {
  blockRefreshUntil,
  type Connection,
  deleteConnection,
  ensureSchema,
  openToken,
  readConnection,
  sealTokens,
  touchLastUsed,
  updateTokens,
  writeConnection,
} from "./token-store";
import { clearRevocation, ensureRevocationSchema, readRevocation, writeRevocation } from "./grant-revocation";
import { ensureLimitsSchema } from "./limits";
import { MailboxOperations, type SendResult, type VaultResult } from "./operations";

export type { VaultResult } from "./operations";

/** Key of the token door. Only this module, the vault's own operations and tests hold it. */
export const WITH_ACCESS_TOKEN: unique symbol = Symbol("MailboxVault.withAccessToken");

export type WipeReason = "blocked" | "upstream_revoked" | "grants_gone" | "idle";

const SECOND_MS = 1000;
/** An access token with less than this left is refreshed before use. */
const ACCESS_TOKEN_MARGIN_MS = 60 * SECOND_MS;
/**
 * After a refresh that Stalwart rejected for a reason other than `invalid_grant` (e.g. wrong
 * client credentials) no new attempt is made for this long, so a Worker-side fault does not
 * turn into a stream of failed authentications from our addresses.
 */
const REFRESH_BACKOFF_MS = MAIL_LIMITS.refreshBackoffSeconds * SECOND_MS;
const REVOKE_RETRY_MS = MAIL_LIMITS.grantRevokeRetrySeconds * SECOND_MS;

export class MailboxVault extends DurableObject<Env> {
  /** The JMAP session, fetched once per instance and dropped on every sign-in or wipe. */
  #session: JmapSession | null = null;
  /** The refresh in flight; every concurrent caller awaits the same one. */
  #refreshing: Promise<Lease> | null = null;
  readonly #operations: MailboxOperations;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureSchema(ctx.storage.sql);
    ensureLimitsSchema(ctx.storage.sql);
    ensureRevocationSchema(ctx.storage.sql);
    this.#operations = new MailboxOperations({
      sql: ctx.storage.sql,
      env,
      withAccessToken: (fn) => this[WITH_ACCESS_TOKEN](fn),
    });
  }

  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /**
   * Called once by the sign-in flow with fresh tokens. A second sign-in for the same address
   * replaces them and keeps the mailbox's Worker grants (a second AI tool). A connection that is
   * new, or for another address, never inherits grants: every Worker grant of the account is
   * revoked first, and if that fails nothing is stored. Whether the earlier tools keep their
   * grants is the user's decision on the approval page, which names them.
   */
  async storeTokens(input: { accountId: string; email: string; origin: string } & UpstreamTokens): Promise<void> {
    return mailErrorsOnly(async () => {
      const existing = readConnection(this.#sql);
      if (existing && existing.accountId !== input.accountId) throw new MailError("account_mismatch");
      if (!existing || !sameAddress(existing.email, input.email)) {
        try {
          await grantDirectory(this.env, input.origin).revokeAll(input.accountId);
        } catch {
          throw new MailError("internal");
        }
      }
      const boxes = await sealTokens(this.env.TOKEN_ENC_KEY, input.accountId, input);
      const now = clock.now();
      writeConnection(this.#sql, {
        accountId: input.accountId,
        email: input.email,
        origin: input.origin,
        ...boxes,
        accessExpiresAt: input.accessExpiresAt,
        lastUsedAt: now,
        now,
      });
      // Every grant of the account was revoked above or belongs to this connection's address.
      clearRevocation(this.#sql);
      this.#session = null;
      // A sign-in that never turns into a Worker grant is wiped by the alarm.
      await this.ctx.storage.setAlarm(now + MAIL_LIMITS.abandonedSignInSeconds * SECOND_MS);
    });
  }

  async status(): Promise<{ connected: boolean; email: string | null; lastUsedAt: number | null }> {
    return mailErrorsOnly(async () => {
      const c = readConnection(this.#sql);
      return c ? { connected: true, email: c.email, lastUsedAt: c.lastUsedAt } : { connected: false, email: null, lastUsedAt: null };
    });
  }

  /**
   * Allow created a Worker grant for the stored connection: the next grant check is a day away,
   * so the 10-minute check for an abandoned sign-in cannot wipe it while KV does not list the
   * grant yet. Without a connection it does nothing.
   */
  async confirmGrant(): Promise<void> {
    return mailErrorsOnly(async () => {
      if (!readConnection(this.#sql)) return;
      await this.ctx.storage.setAlarm(clock.now() + MAIL_LIMITS.grantCheckSeconds * SECOND_MS);
    });
  }

  /** Ends the connection. Without a stored connection it does nothing and writes nothing. */
  async wipe(reason: WipeReason): Promise<void> {
    return mailErrorsOnly(async () => {
      await this.#wipeConnection(reason);
    });
  }

  /**
   * Checks the Worker grants; wipes a connection without grants or one idle too long. The next
   * check is armed first, so a failing lookup can never leave a connection without an alarm.
   * Without a connection it finishes a wipe's grant revocation, if one is pending.
   */
  override async alarm(): Promise<void> {
    this.#operations.pruneRecentSends();
    const c = readConnection(this.#sql);
    if (!c) {
      await this.#finishRevocation();
      return;
    }
    await this.ctx.storage.setAlarm(clock.now() + MAIL_LIMITS.grantCheckSeconds * SECOND_MS);
    let hasGrants: boolean;
    try {
      hasGrants = await grantDirectory(this.env, c.origin).hasGrants(c.accountId);
    } catch {
      return; // the re-armed alarm tries again
    }
    // Both wipes concern only the connection the lookup was made for.
    if (!hasGrants) {
      await this.#wipeConnection("grants_gone", c.generation);
      return;
    }
    const current = readConnection(this.#sql);
    if (current?.generation !== c.generation) return;
    if (clock.now() - current.lastUsedAt > MAIL_LIMITS.idleWipeSeconds * SECOND_MS) {
      await this.#wipeConnection("idle", c.generation);
    }
  }

  // ---- mailbox operations (RPC): plain `VaultResult`s, never a throw ----

  // `accountId` and `email` are the calling grant's; both must match the stored connection.

  listMailboxes(accountId: string, email: string): Promise<VaultResult<{ folders: MailFolder[] }>> {
    return this.#operations.listMailboxes({ accountId, email });
  }

  searchMail(
    accountId: string,
    email: string,
    input: SearchMailInputT,
  ): Promise<VaultResult<{ messages: MailSummary[]; next_offset: number | null }>> {
    return this.#operations.searchMail({ accountId, email }, input);
  }

  readThread(
    accountId: string,
    email: string,
    input: ReadThreadInputT,
  ): Promise<VaultResult<{ thread_id: string; messages: ThreadMessage[]; omitted_messages: number }>> {
    return this.#operations.readThread({ accountId, email }, input);
  }

  createDraft(
    accountId: string,
    email: string,
    input: OutgoingMessage,
  ): Promise<VaultResult<{ draft_id: string; folder_id: string }>> {
    return this.#operations.createDraft({ accountId, email }, input);
  }

  moveMail(accountId: string, email: string, input: MoveMailRequestT): Promise<VaultResult<MoveMailOutcome>> {
    return this.#operations.moveMail({ accountId, email }, input);
  }

  markMail(accountId: string, email: string, input: MarkMailInputT): Promise<VaultResult<MarkMailOutcome>> {
    return this.#operations.markMail({ accountId, email }, input);
  }

  readAttachment(accountId: string, email: string, input: ReadAttachmentInputT): Promise<VaultResult<AttachmentDelivery>> {
    return this.#operations.readAttachment({ accountId, email }, input);
  }

  /** The read-only contacts and calendar operations; `request` is validated by the operations. */
  collab(accountId: string, email: string, request: CollabRequestT): Promise<VaultResult<CollabValue>> {
    return this.#operations.collab({ accountId, email }, request);
  }

  sendMail(accountId: string, email: string, input: OutgoingMessage): Promise<VaultResult<SendResult>> {
    return this.#operations.sendMail({ accountId, email }, input);
  }

  /**
   * Runs `fn` with a valid access token and the mailbox's JMAP session. An `UpstreamAuthError`
   * from `fn` (or the session fetch) with a cached token leads to one refresh and one retry; the
   * same error right after a successful refresh ends the connection (`reconnect_required`). When
   * a new sign-in replaces the connection meanwhile, the call starts over once on the new one.
   * Symbol-keyed, so it is not part of the RPC surface.
   */
  async [WITH_ACCESS_TOKEN]<T>(fn: (token: string, session: JmapSession) => Promise<T>): Promise<T> {
    try {
      return await this.#withConnection(fn);
    } catch (e) {
      if (!(e instanceof ConnectionChanged)) throw e;
    }
    try {
      return await this.#withConnection(fn);
    } catch (e) {
      if (e instanceof ConnectionChanged) throw new MailError("upstream_unavailable");
      throw e;
    }
  }

  /**
   * Deletes the stored connection and ends its grants. With `expected`, only if the stored
   * connection is still that one. Returns whether it wiped. A failed revocation of the Worker
   * grants is audited as an error and retried by the alarm; it does not fail the wipe.
   */
  async #wipeConnection(reason: WipeReason, expected?: string): Promise<boolean> {
    const c = readConnection(this.#sql);
    if (!c || (expected !== undefined && c.generation !== expected)) return false;
    // Gone first, so no concurrent caller uses the connection while the upstream calls run.
    deleteConnection(this.#sql);
    this.#session = null;
    await this.ctx.storage.deleteAlarm();

    // `grants_gone`: the alarm found none, so there is nothing to revoke.
    const revokesGrants = reason !== "grants_gone";
    let grantsLeft = false;
    if (revokesGrants) {
      try {
        await grantDirectory(this.env, c.origin).revokeAll(c.accountId);
      } catch {
        grantsLeft = true;
      }
    }
    // After `upstream_revoked` Stalwart has already dropped the grant.
    if (reason !== "upstream_revoked") {
      const refreshToken = await openToken(this.env.TOKEN_ENC_KEY, c.accountId, c.refreshBox).catch(() => null);
      if (refreshToken) await revokeToken(this.env, refreshToken);
    }
    const outcome = grantsLeft ? "error" : "ok";
    await writeAudit(
      this.env.DB,
      reason === "upstream_revoked"
        ? { event: "upstream_revoked", outcome, accountId: c.accountId, email: c.email }
        : { event: "connection_wiped", outcome, errorCode: reason, accountId: c.accountId, email: c.email },
    );
    if (revokesGrants) await this.#scheduleRevocation(c, grantsLeft ? "retry" : "follow_up");
    return true;
  }

  /** Arms the alarm that runs a wipe's grant revocation (again) in 5 minutes. */
  async #scheduleRevocation(c: Connection, kind: "retry" | "follow_up"): Promise<void> {
    // A sign-in that landed meanwhile revoked every grant itself and owns the alarm now.
    if (readConnection(this.#sql)) return;
    const now = clock.now();
    writeRevocation(this.#sql, {
      accountId: c.accountId,
      origin: c.origin,
      kind,
      giveUpAt: now + MAIL_LIMITS.grantRevokeRetryWindowSeconds * SECOND_MS,
    });
    await this.ctx.storage.setAlarm(now + REVOKE_RETRY_MS);
  }

  /** The alarm without a connection: revoke the wiped connection's grants once more, or retry later. */
  async #finishRevocation(): Promise<void> {
    const pending = readRevocation(this.#sql);
    if (!pending) return;
    try {
      await grantDirectory(this.env, pending.origin).revokeAll(pending.accountId);
    } catch {
      // A sign-in meanwhile cleared the row and revoked the grants itself.
      if (readConnection(this.#sql) || !readRevocation(this.#sql)) return;
      const next = clock.now() + REVOKE_RETRY_MS;
      if (next > pending.giveUpAt) {
        clearRevocation(this.#sql);
        return;
      }
      writeRevocation(this.#sql, { ...pending, kind: "retry" });
      await this.ctx.storage.setAlarm(next);
      return;
    }
    if (!readConnection(this.#sql)) clearRevocation(this.#sql);
  }

  async #withConnection<T>(fn: (token: string, session: JmapSession) => Promise<T>): Promise<T> {
    const first = await this.#accessToken();
    try {
      return await this.#runWith(first, fn);
    } catch (e) {
      if (!(e instanceof UpstreamAuthError)) throw e;
      if (first.refreshed) return this.#endRevoked(first.generation);
    }
    const retry = await this.#tokenAfterRejection(first);
    try {
      return await this.#runWith(retry, fn);
    } catch (e) {
      if (e instanceof UpstreamAuthError) return this.#endRevoked(retry.generation);
      throw e;
    }
  }

  #connection(): Connection {
    const c = readConnection(this.#sql);
    if (!c) throw new MailError("reconnect_required");
    return c;
  }

  #open(c: Connection, box: Connection["accessBox"]): Promise<string> {
    return openToken(this.env.TOKEN_ENC_KEY, c.accountId, box);
  }

  #hasValidAccessToken(c: Connection): boolean {
    return c.accessExpiresAt - clock.now() > ACCESS_TOKEN_MARGIN_MS;
  }

  async #accessToken(): Promise<Lease> {
    if (this.#refreshing) return this.#refreshing;
    const c = this.#connection();
    if (this.#hasValidAccessToken(c)) return { token: await this.#open(c, c.accessBox), generation: c.generation, refreshed: false };
    return this.#refresh();
  }

  /** Stalwart refused `failed`: use a token another caller refreshed meanwhile, or refresh. */
  async #tokenAfterRejection(failed: Lease): Promise<Lease> {
    if (this.#refreshing) return this.#refreshing;
    const c = this.#connection();
    if (c.generation !== failed.generation) throw new ConnectionChanged();
    if (this.#hasValidAccessToken(c)) {
      const stored = await this.#open(c, c.accessBox);
      if (stored !== failed.token) return { token: stored, generation: c.generation, refreshed: false };
    }
    return this.#refresh();
  }

  #refresh(): Promise<Lease> {
    this.#refreshing ??= this.#runRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #runRefresh(): Promise<Lease> {
    const c = this.#connection();
    if (c.refreshBlockedUntil > clock.now()) throw new MailError("upstream_unavailable");
    const refreshToken = await this.#open(c, c.refreshBox);

    let tokens: UpstreamTokens;
    try {
      tokens = await refreshTokens(this.env, refreshToken);
    } catch (e) {
      if (e instanceof InvalidGrantError) {
        // Only the grant we presented is dead; a sign-in that replaced it meanwhile is not.
        if (await this.#wipeConnection("upstream_revoked", c.generation)) throw new MailError("reconnect_required");
        return this.#currentLease();
      }
      if (e instanceof MailError) {
        if (e.code === "upstream_rejected") {
          blockRefreshUntil(this.#sql, c.generation, clock.now() + REFRESH_BACKOFF_MS);
        }
        throw e;
      }
      throw new MailError("internal");
    }

    // The rotated refresh token is stored before any caller gets the access token.
    const boxes = await sealTokens(this.env.TOKEN_ENC_KEY, c.accountId, tokens);
    if (!updateTokens(this.#sql, c.generation, { ...boxes, accessExpiresAt: tokens.accessExpiresAt })) {
      // The connection was wiped or replaced while we waited: end the grant we just refreshed.
      await revokeToken(this.env, tokens.refreshToken);
      return this.#currentLease();
    }
    return { token: tokens.accessToken, generation: c.generation, refreshed: true };
  }

  /** The stored connection's token, refreshed if needed; `reconnect_required` when there is none. */
  async #currentLease(): Promise<Lease> {
    const c = this.#connection();
    if (this.#hasValidAccessToken(c)) return { token: await this.#open(c, c.accessBox), generation: c.generation, refreshed: false };
    return this.#runRefresh();
  }

  async #runWith<T>(lease: Lease, fn: (token: string, session: JmapSession) => Promise<T>): Promise<T> {
    const session = this.#session ?? (await fetchSession(lease.token));
    // Checked after the session fetch: `fn` only ever runs for the connection the token belongs to.
    const c = this.#connection();
    if (c.generation !== lease.generation) throw new ConnectionChanged();
    if (session.accountId !== c.accountId) throw new MailError("account_mismatch");
    this.#session = session;
    const result = await fn(lease.token, session);
    touchLastUsed(this.#sql, clock.now());
    return result;
  }

  /** The connection `generation` answered 401 right after a refresh: end it, unless it was replaced. */
  async #endRevoked(generation: string): Promise<never> {
    if (!(await this.#wipeConnection("upstream_revoked", generation)) && readConnection(this.#sql)) {
      throw new ConnectionChanged();
    }
    throw new MailError("reconnect_required");
  }
}

/** An access token and the connection (generation) it belongs to. */
interface Lease {
  token: string;
  generation: string;
  refreshed: boolean;
}

/** Internal signal: the stored connection was replaced; `withAccessToken` starts over once. */
class ConnectionChanged extends Error {
  constructor() {
    super("The stored connection changed.");
    this.name = "ConnectionChanged";
  }
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Any other failure leaves an RPC method as `MailError("internal")`, without its detail. */
async function mailErrorsOnly<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof MailError) throw e;
    throw new MailError("internal");
  }
}

/**
 * The vault of a mailbox. With `DATA_JURISDICTION` set, the vault runs and stores its data only
 * there; the same account id names a different vault in each jurisdiction and in none.
 */
export function vaultFor(env: Env, accountId: string): DurableObjectStub<MailboxVault> {
  // `Env` leaves the namespace untyped (see env.ts); the binding is declared for this class only.
  const namespace = env.MAILBOX_VAULT as unknown as DurableObjectNamespace<MailboxVault>;
  const jurisdiction = dataJurisdiction(env.DATA_JURISDICTION);
  if (jurisdiction === null) throw new MailError("internal");
  const scoped = jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction);
  return scoped.get(scoped.idFromName(accountId));
}
