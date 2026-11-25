/**
 * In-memory stand-in for the Stalwart mail server, shared by every mail-mcp test.
 * Install with `vi.stubGlobal("fetch", fake.fetch)`. State, OAuth endpoints, the fetch router
 * and the helper API live here; the JMAP method handlers live in `fake-stalwart-jmap.ts`.
 * Deterministic: ids, tokens and dates come from counters; expiry uses `clock.now()`.
 */
import { clock } from "../src/clock";
import { STALWART } from "../src/stalwart/endpoints";
import { handleJmapRequest } from "./fake-stalwart-jmap";
import type { FakeAccount, FakeAddress, FakeEmail, FakeFolder, FakeState, SentMessage } from "./fake-stalwart-state";

export type { FakeAccount, FakeAddress, FakeAttachment, FakeEmail, FakeFolder, FakeIdentity, FakeState, SentMessage } from "./fake-stalwart-state";

export interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  /** Parsed JSON for JSON bodies, an object of fields for form bodies, the raw text otherwise, null when empty. */
  // `any` on purpose: tests read recorded bodies freely (`r.body.methodCalls`, `r.body.grant_type`).
  body: any;
}

export type FailureKind = "http-503" | "http-401" | "network" | "invalid-json" | "submission-rejected";

/**
 * A failure of the next JMAP request that holds `EmailSubmission/set`: `network` fails before the
 * fake sees the request; the `accepted-then-*` kinds process it (the message is sent) and then
 * answer a 503, an unparseable body, or a 200 without method responses.
 */
export type SubmitFailureKind = "network" | "accepted-then-503" | "accepted-then-invalid-json" | "accepted-then-empty";

export interface AddMailboxOptions {
  drafts?: boolean; // default true
  sent?: boolean; // default true
  /** false: no identity; an object overrides the identity's name and/or address. Default: the mailbox address. */
  identity?: boolean | { name?: string; email?: string };
}

export interface AddMessageOptions {
  subject?: string;
  from?: FakeAddress[];
  to?: FakeAddress[];
  cc?: FakeAddress[];
  body?: string; // text/plain part
  html?: string; // text/html part
  preview?: string; // default: derived from the body, 256 characters at most
  folder?: string; // a role ("inbox", "drafts", "sent", "trash") or a folder id; default "inbox"
  threadId?: string; // join an existing thread of the same mailbox
  receivedAt?: string; // default: a counter-based time, later for each message
  unread?: boolean; // default true (no $seen)
  flagged?: boolean;
  keywords?: string[];
  attachments?: { name: string | null; size: number; type: string }[];
  messageId?: string;
  inReplyTo?: string[];
  references?: string[];
}

export interface FakeTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
}

export interface FakeStalwart {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
  addMailbox(email: string, options?: AddMailboxOptions): { accountId: string };
  addMessage(email: string, options?: AddMessageOptions): { id: string; threadId: string; folderId: string };
  tokensFor(email: string): FakeTokens;
  /** A code for `email`, redeemable only with the verifier of `codeChallenge` (S256; see `pkceChallenge`). */
  issueCode(email: string, options: { codeChallenge: string; redirectUri?: string }): string;
  /**
   * The sign-in step at `/login`: checks the URL our `/authorize` redirected to and returns the
   * callback URL with a code bound to its `code_challenge` and `redirect_uri` (or `error=access_denied`).
   */
  authorize(locationUrl: string, email: string, options?: { deny?: boolean }): string;
  revokeGrant(email: string): void;
  revoked(email: string): boolean;
  knowsToken(token: string): boolean;
  /** True while `token` (access or current refresh token) belongs to a grant that was not ended. */
  isLive(token: string): boolean;
  /** The tokens of every grant issued to `email` by a code exchange, oldest first, as first issued. */
  issuedByCode(email: string): FakeTokens[];
  sent(email: string): SentMessage[];
  failNext(kind: FailureKind): void;
  failNextSubmit(kind: SubmitFailureKind): void;
  omitRefreshTokenOnce(): void;
  expireAccessToken(email: string): void;
  folderId(email: string, role: string): string | null;
  email(email: string, id: string): FakeEmail | undefined;
}

const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const ACCESS_TTL_SECONDS = 3600;
const RECEIVED_BASE = Date.UTC(2026, 0, 1);

interface Grant {
  email: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  supersededRefreshTokens: Set<string>;
}

interface PendingCode {
  email: string;
  codeChallenge: string;
  redirectUri?: string;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === "") return null;
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

/** The S256 PKCE challenge of `verifier`. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createFakeStalwart(): FakeStalwart {
  const counters = new Map<string, number>();
  let receivedSeq = 0;
  const accounts = new Map<string, FakeAccount>(); // by lower-case address
  const grants: Grant[] = [];
  const codes = new Map<string, PendingCode>();
  const issuedTokens = new Set<string>();
  const revokedEmails = new Set<string>();
  const transportFailures: FailureKind[] = [];
  const submitFailures: SubmitFailureKind[] = [];
  const codeGrants: (FakeTokens & { email: string })[] = [];
  let submissionRejections = 0;
  let omitRefreshToken = false;
  const requests: RecordedRequest[] = [];

  const nextId = (prefix: string): string => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}${n}`;
  };

  const state: FakeState = {
    nextId,
    nextReceivedAt: () => new Date(RECEIVED_BASE + ++receivedSeq * 60_000).toISOString(),
    takeSubmissionRejection: () => {
      if (submissionRejections === 0) return false;
      submissionRejections--;
      return true;
    },
  };

  const key = (email: string) => email.toLowerCase();

  function addMailbox(email: string, options: AddMailboxOptions = {}): { accountId: string } {
    if (accounts.has(key(email))) throw new Error(`fake-stalwart: mailbox ${email} exists already`);
    const account: FakeAccount = {
      accountId: nextId("acc"),
      email,
      folders: new Map(),
      emails: new Map(),
      identities: [],
      sent: [],
    };
    const folder = (name: string, role: string) => {
      const f: FakeFolder = { id: nextId("mb"), name, role, parentId: null };
      account.folders.set(f.id, f);
    };
    folder("Inbox", "inbox");
    if (options.drafts !== false) folder("Drafts", "drafts");
    if (options.sent !== false) folder("Sent Items", "sent");
    folder("Deleted Items", "trash");
    if (options.identity !== false) {
      const custom = typeof options.identity === "object" ? options.identity : {};
      account.identities.push({
        id: nextId("idn"),
        name: custom.name ?? email.split("@")[0] ?? "",
        email: custom.email ?? email,
      });
    }
    accounts.set(key(email), account);
    return { accountId: account.accountId };
  }

  function accountFor(email: string): FakeAccount {
    const existing = accounts.get(key(email));
    if (existing) return existing;
    addMailbox(email);
    return accounts.get(key(email))!;
  }

  function resolveFolder(account: FakeAccount, folder: string): FakeFolder {
    const byId = account.folders.get(folder);
    if (byId) return byId;
    for (const f of account.folders.values()) if (f.role === folder) return f;
    throw new Error(`fake-stalwart: ${account.email} has no folder ${folder}`);
  }

  function addMessage(
    email: string,
    o: AddMessageOptions = {},
  ): { id: string; threadId: string; folderId: string } {
    const account = accountFor(email);
    const folder = resolveFolder(account, o.folder ?? "inbox");
    if (o.threadId !== undefined && ![...account.emails.values()].some((e) => e.threadId === o.threadId)) {
      throw new Error(`fake-stalwart: ${account.email} has no thread ${o.threadId}`);
    }
    const id = nextId("em");
    const text = o.body ?? (o.html === undefined ? "" : null);
    const html = o.html ?? null;
    const keywords: Record<string, true> = {};
    if (o.unread === false) keywords.$seen = true;
    if (o.flagged) keywords.$flagged = true;
    for (const k of o.keywords ?? []) keywords[k] = true;
    const plain = text ?? (html ?? "").replace(/<[^>]*>/g, " ");
    const message: FakeEmail = {
      id,
      blobId: nextId("bl"),
      threadId: o.threadId ?? nextId("th"),
      mailboxIds: { [folder.id]: true },
      keywords,
      from: o.from ?? [{ name: "Sender", email: "sender@elsewhere.example" }],
      to: o.to ?? [{ name: null, email: account.email }],
      cc: o.cc ?? [],
      bcc: [],
      subject: o.subject ?? "",
      receivedAt: o.receivedAt ?? state.nextReceivedAt(),
      messageId: [o.messageId ?? `${id}@fake.stalwart`],
      inReplyTo: o.inReplyTo ?? null,
      references: o.references ?? null,
      text,
      html,
      preview: o.preview ?? plain.replace(/\s+/g, " ").trim().slice(0, 256),
      attachments: (o.attachments ?? []).map((a) => ({ ...a, blobId: nextId("bl") })),
    };
    account.emails.set(id, message);
    return { id, threadId: message.threadId, folderId: folder.id };
  }

  function newGrant(email: string): Grant {
    const grant: Grant = {
      email,
      accessToken: nextId("fake-at-"),
      accessExpiresAt: clock.now() + ACCESS_TTL_SECONDS * 1000,
      refreshToken: nextId("fake-rt-"),
      supersededRefreshTokens: new Set(),
    };
    issuedTokens.add(grant.accessToken).add(grant.refreshToken);
    grants.push(grant);
    return grant;
  }

  function dropGrant(grant: Grant): void {
    const i = grants.indexOf(grant);
    if (i !== -1) grants.splice(i, 1);
  }

  function tokenResponse(grant: Grant): Response {
    const body: Record<string, unknown> = {
      access_token: grant.accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      scope: STALWART.scope,
    };
    if (omitRefreshToken) omitRefreshToken = false;
    else body.refresh_token = grant.refreshToken;
    return json(body, 200, { "Cache-Control": "no-store" });
  }

  function clientAuthenticated(req: Request): boolean {
    return req.headers.get("authorization") === `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
  }

  async function tokenEndpoint(req: Request, form: URLSearchParams): Promise<Response> {
    if (!clientAuthenticated(req)) return json({ error: "invalid_client" }, 401);
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const pending = codes.get(code);
      const verifier = form.get("code_verifier");
      const redirectUri = form.get("redirect_uri");
      if (!verifier || !redirectUri) return json({ error: "invalid_request" }, 400);
      if (!pending) return json({ error: "invalid_grant" }, 400);
      codes.delete(code);
      if (pending.redirectUri !== undefined && pending.redirectUri !== redirectUri) {
        return json({ error: "invalid_grant" }, 400);
      }
      // PKCE is mandatory, as at Stalwart: every code is bound to a challenge.
      if (pending.codeChallenge !== (await pkceChallenge(verifier))) {
        return json({ error: "invalid_grant" }, 400);
      }
      const grant = newGrant(pending.email);
      codeGrants.push({ email: pending.email, accessToken: grant.accessToken, refreshToken: grant.refreshToken, accessExpiresAt: grant.accessExpiresAt });
      return tokenResponse(grant);
    }
    if (grantType === "refresh_token") {
      const presented = form.get("refresh_token") ?? "";
      const current = grants.find((g) => g.refreshToken === presented);
      if (current) {
        current.supersededRefreshTokens.add(current.refreshToken);
        current.accessToken = nextId("fake-at-");
        current.refreshToken = nextId("fake-rt-");
        current.accessExpiresAt = clock.now() + ACCESS_TTL_SECONDS * 1000;
        issuedTokens.add(current.accessToken).add(current.refreshToken);
        return tokenResponse(current);
      }
      // Reuse of a rotated refresh token: treat as theft and end the whole grant.
      const reused = grants.find((g) => g.supersededRefreshTokens.has(presented));
      if (reused) dropGrant(reused);
      return json({ error: "invalid_grant" }, 400);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  function revokeEndpoint(req: Request, form: URLSearchParams): Response {
    if (!clientAuthenticated(req)) return json({ error: "invalid_client" }, 401);
    const token = form.get("token") ?? "";
    const grant = grants.find(
      (g) => g.accessToken === token || g.refreshToken === token || g.supersededRefreshTokens.has(token),
    );
    if (grant) {
      dropGrant(grant);
      revokedEmails.add(key(grant.email));
    }
    return new Response(null, { status: 200 });
  }

  function bearerAccount(req: Request): FakeAccount | null {
    const header = req.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const grant = grants.find((g) => g.accessToken === token);
    if (!grant || grant.accessExpiresAt <= clock.now()) return null;
    return accounts.get(key(grant.email)) ?? null;
  }

  function sessionObject(account: FakeAccount): unknown {
    const api = `${STALWART.origin}/jmap/`;
    return {
      capabilities: {
        "urn:ietf:params:jmap:core": {
          maxSizeUpload: 50_000_000,
          maxConcurrentUpload: 4,
          maxSizeRequest: 10_000_000,
          maxConcurrentRequests: 4,
          maxCallsInRequest: 16,
          maxObjectsInGet: 500,
          maxObjectsInSet: 500,
          collationAlgorithms: ["i;ascii-casemap"],
        },
        "urn:ietf:params:jmap:mail": {},
        "urn:ietf:params:jmap:submission": {},
      },
      accounts: {
        [account.accountId]: {
          name: account.email,
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {
            "urn:ietf:params:jmap:mail": { maxMailboxesPerEmail: null, emailQuerySortOptions: ["receivedAt"] },
            "urn:ietf:params:jmap:submission": { maxDelayedSend: 0, submissionExtensions: {} },
          },
        },
      },
      primaryAccounts: {
        "urn:ietf:params:jmap:mail": account.accountId,
        "urn:ietf:params:jmap:submission": account.accountId,
      },
      username: account.email,
      apiUrl: api,
      downloadUrl: `${api}download/{accountId}/{blobId}/{name}?accept={type}`,
      uploadUrl: `${api}upload/{accountId}/`,
      eventSourceUrl: `${api}eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
      state: "fake-session-1",
    };
  }

  function unauthorized(): Response {
    return new Response("fake-stalwart: unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="fake-stalwart"' },
    });
  }

  async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const text = req.method === "GET" || req.method === "HEAD" ? "" : new TextDecoder().decode(await req.arrayBuffer());
    requests.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.get("authorization"),
      body: parseBody(text, req.headers.get("content-type")),
    });
    const url = new URL(req.url);
    if (url.origin !== STALWART.origin) throw new TypeError("fake-stalwart: no route to host");

    const failure = transportFailures.shift();
    if (failure === "network") throw new TypeError("fake-stalwart: network failure");
    if (failure === "http-503") return new Response("fake-stalwart upstream detail: overloaded", { status: 503 });
    if (failure === "http-401") return unauthorized();
    if (failure === "invalid-json") {
      return new Response("<html>fake-stalwart upstream detail</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/jmap/session" && req.method === "GET") {
      const account = bearerAccount(req);
      return account ? json(sessionObject(account)) : unauthorized();
    }
    if ((url.pathname === "/jmap/" || url.pathname === "/jmap") && req.method === "POST") {
      const account = bearerAccount(req);
      if (!account) return unauthorized();
      const submitFailure = text.includes("EmailSubmission/set") ? submitFailures.shift() : undefined;
      if (submitFailure === "network") throw new TypeError("fake-stalwart: network failure");
      const result = handleJmapRequest(state, account, parseBody(text, "application/json"));
      if (submitFailure === "accepted-then-503") return new Response("fake-stalwart upstream detail", { status: 503 });
      if (submitFailure === "accepted-then-invalid-json") {
        return new Response("<html>fake-stalwart upstream detail", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (submitFailure === "accepted-then-empty") return json({ methodResponses: [], sessionState: "fake-session-1" });
      return json(result.body, result.status);
    }
    if (url.pathname === "/auth/token" && req.method === "POST") {
      return tokenEndpoint(req, new URLSearchParams(text));
    }
    if (url.pathname === "/auth/revoke" && req.method === "POST") {
      return revokeEndpoint(req, new URLSearchParams(text));
    }
    return new Response("fake-stalwart: not found", { status: 404 });
  }

  return {
    fetch: fakeFetch,
    requests,
    addMailbox,
    addMessage,
    tokensFor(email) {
      accountFor(email);
      const grant = [...grants].reverse().find((g) => key(g.email) === key(email)) ?? newGrant(email);
      return {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        accessExpiresAt: grant.accessExpiresAt,
      };
    },
    issueCode(email, options) {
      accountFor(email);
      const code = nextId("fake-code-");
      codes.set(code, { email, ...options });
      return code;
    },
    authorize(locationUrl, email, options = {}) {
      const url = new URL(locationUrl);
      const p = url.searchParams;
      const challenge = p.get("code_challenge");
      const redirectUri = p.get("redirect_uri");
      const state = p.get("state");
      if (`${url.origin}${url.pathname}` !== STALWART.authorize) throw new Error("fake-stalwart: not the login page");
      if (p.get("client_id") !== CLIENT_ID) throw new Error("fake-stalwart: unknown client_id");
      if (p.get("response_type") !== "code") throw new Error("fake-stalwart: response_type must be code");
      if (p.get("scope") !== STALWART.scope) throw new Error("fake-stalwart: unexpected scope");
      if (p.get("code_challenge_method") !== "S256" || !challenge) throw new Error("fake-stalwart: PKCE S256 required");
      if (!redirectUri || !state) throw new Error("fake-stalwart: redirect_uri and state required");
      const back = new URL(redirectUri);
      if (options.deny) {
        back.search = new URLSearchParams({ error: "access_denied", state }).toString();
        return back.toString();
      }
      accountFor(email);
      const code = nextId("fake-code-");
      codes.set(code, { email, codeChallenge: challenge, redirectUri });
      back.search = new URLSearchParams({ code, state, iss: STALWART.origin }).toString();
      return back.toString();
    },
    revokeGrant(email) {
      for (const g of grants.filter((g) => key(g.email) === key(email))) dropGrant(g);
    },
    revoked: (email) => revokedEmails.has(key(email)),
    knowsToken: (token) => issuedTokens.has(token),
    isLive: (token) => grants.some((g) => g.accessToken === token || g.refreshToken === token),
    issuedByCode: (email) =>
      codeGrants
        .filter((g) => key(g.email) === key(email))
        .map(({ accessToken, refreshToken, accessExpiresAt }) => ({ accessToken, refreshToken, accessExpiresAt })),
    sent: (email) => [...(accounts.get(key(email))?.sent ?? [])],
    failNext(kind) {
      if (kind === "submission-rejected") submissionRejections++;
      else transportFailures.push(kind);
    },
    failNextSubmit(kind) {
      submitFailures.push(kind);
    },
    omitRefreshTokenOnce() {
      omitRefreshToken = true;
    },
    expireAccessToken(email) {
      for (const g of grants) if (key(g.email) === key(email)) g.accessExpiresAt = clock.now() - 1;
    },
    folderId(email, role) {
      for (const f of accounts.get(key(email))?.folders.values() ?? []) if (f.role === role) return f.id;
      return null;
    },
    email: (email, id) => accounts.get(key(email))?.emails.get(id),
  };
}
