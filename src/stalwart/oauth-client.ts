/**
 * This worker as an OAuth client of Stalwart's own endpoints (authorization code + PKCE,
 * refresh, revoke). Client authentication is `client_secret_basic`. Upstream text never
 * reaches an error message.
 */
import { MailError } from "../mail";
import { clock } from "../clock";
import type { Env } from "../env";
import { STALWART } from "./endpoints";
import { readJsonBody, stalwartFetch } from "./http";

export interface UpstreamTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  accessExpiresAt: number;
}

/**
 * Stalwart says this refresh token is dead: the JSON body of the token answer carries
 * `error: "invalid_grant"` (RFC 6749 section 5.2), at any HTTP status. Only this answer may end
 * a customer's connection; every other failure is a `MailError`. A bare 401 is not enough: it is
 * also how a failed client authentication (`invalid_client`: wrong or missing client secret,
 * deleted client) answers, which is a Worker-side misconfiguration hitting every mailbox.
 */
export class InvalidGrantError extends Error {
  constructor() {
    super("The mail server no longer accepts this grant.");
    this.name = "InvalidGrantError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The client credentials, or null when either is missing or empty (then no request may be sent). */
function clientAuth(env: Env): string | null {
  const id = env.STALWART_OAUTH_CLIENT_ID;
  const secret = env.STALWART_OAUTH_CLIENT_SECRET;
  if (!id || !secret) return null;
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

function postForm(authorization: string, url: string, fields: Record<string, string>): Promise<Response> {
  return stalwartFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: authorization,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function tokensFrom(res: Response): Promise<UpstreamTokens> {
  const body = await readJsonBody(res);
  if (!isObject(body)) throw new MailError("upstream_rejected");
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = body;
  if (typeof accessToken !== "string" || accessToken === "") throw new MailError("upstream_rejected");
  if (typeof refreshToken !== "string" || refreshToken === "") throw new MailError("upstream_rejected");
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new MailError("upstream_rejected");
  }
  return { accessToken, refreshToken, accessExpiresAt: clock.now() + expiresIn * 1000 };
}

/** Maps a non-200 token answer: 5xx is unavailable, everything else is rejected. */
async function failure(res: Response): Promise<MailError> {
  await res.body?.cancel();
  return new MailError(res.status >= 500 ? "upstream_unavailable" : "upstream_rejected");
}

export async function exchangeCode(
  env: Env,
  p: { code: string; codeVerifier: string; redirectUri: string },
): Promise<UpstreamTokens> {
  const authorization = clientAuth(env);
  if (!authorization) throw new MailError("internal");
  const res = await postForm(authorization, STALWART.token, {
    grant_type: "authorization_code",
    code: p.code,
    code_verifier: p.codeVerifier,
    redirect_uri: p.redirectUri,
  });
  if (res.status !== 200) throw await failure(res);
  return tokensFrom(res);
}

/**
 * Throws `InvalidGrantError` only when the answer's JSON body says `error: "invalid_grant"`
 * (HTTP 400 or 401). A 401 with any other or no error code (e.g. `invalid_client`) is
 * `upstream_rejected`: it points at the Worker's client credentials, not at this mailbox.
 */
export async function refreshTokens(env: Env, refreshToken: string): Promise<UpstreamTokens> {
  const authorization = clientAuth(env);
  if (!authorization) throw new MailError("internal");
  const res = await postForm(authorization, STALWART.token, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (res.status === 400 || res.status === 401) {
    const body = await readJsonBody(res);
    if (isObject(body) && body.error === "invalid_grant") throw new InvalidGrantError();
    throw new MailError("upstream_rejected");
  }
  if (res.status !== 200) throw await failure(res);
  return tokensFrom(res);
}

/** Best effort: tells Stalwart to forget the grant. Never throws, never logs. */
export async function revokeToken(env: Env, refreshToken: string): Promise<void> {
  const authorization = clientAuth(env);
  if (!authorization) return;
  try {
    const res = await postForm(authorization, STALWART.revoke, { token: refreshToken, token_type_hint: "refresh_token" });
    await res.body?.cancel();
  } catch {
    // Nothing to do: the token expires on its own.
  }
}
