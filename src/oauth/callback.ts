/**
 * `GET /callback`: Stalwart sends the browser back. We learn which mailbox signed in, hand its
 * tokens to that mailbox's vault and send the browser to our approval page. No Worker token
 * exists yet; that needs Allow on the page. Every refusal after the code exchange revokes the
 * new Stalwart token, and nothing is stored unless the mailbox may connect.
 */
import { authorizationErrorRedirect, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { isBlocked, writeAudit } from "../audit";
import { cleanText } from "../content/sanitize";
import type { Env } from "../env";
import { fetchSession, type JmapSession } from "../jmap/jmap-client";
import { signInAllowed } from "../policy/environment";
import { STALWART } from "../stalwart/endpoints";
import { exchangeCode, revokeToken, type UpstreamTokens } from "../stalwart/oauth-client";
import { vaultFor } from "../vault/mailbox-vault";
import { pageLanguage, renderMessagePage } from "./approval-page";
import { GrantClientId, GrantProps } from "./grant-props";
import type { UpstreamData } from "./authorize";
import { putPending } from "./pending";

const CLIENT_NAME_MAX = 100;

/** The redirect URI's host; a private-use URI has none, then the whole URI stands for it. */
export function redirectHostOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).hostname || redirectUri;
  } catch {
    return redirectUri;
  }
}

/** The tool's self-chosen name, cleaned and cut; its redirect host when it gave none. */
async function clientLabel(api: OAuthHelpers, authRequest: AuthRequest): Promise<{ clientName: string; redirectHost: string }> {
  const redirectHost = redirectHostOf(authRequest.redirectUri);
  const client = await api.lookupClient(authRequest.clientId);
  const name = cleanText(client?.clientName ?? "", CLIENT_NAME_MAX).text.trim();
  return { clientName: name === "" ? redirectHost : name, redirectHost };
}

function redirect(location: string, ...headerSets: Headers[]): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const set of headerSets) {
    for (const [name, value] of set) if (name !== "set-cookie") headers.set(name, value);
    for (const cookie of set.getSetCookie()) headers.append("Set-Cookie", cookie);
  }
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

export async function handleCallback(request: Request, env: Env, api: OAuthHelpers, origin: string): Promise<Response> {
  const lang = pageLanguage(request);
  const failed = (status: number) => renderMessagePage({ lang, kind: "failed", status });
  const refused = () => renderMessagePage({ lang, kind: "refused", status: 403 });

  // 1. The state must be ours and belong to this browser; it is consumed here.
  let resumed;
  try {
    resumed = await api.finishUpstream<UpstreamData>(request);
  } catch {
    return failed(400);
  }
  const { request: authRequest, data, headers: upstreamHeaders } = resumed;
  const params = new URL(request.url).searchParams;

  // 2. The user declined at Stalwart: the AI tool learns access_denied, nothing else happens.
  if (params.has("error")) {
    return redirect(authorizationErrorRedirect(authRequest, "access_denied"), upstreamHeaders);
  }

  // 3. The answer must come from the mail server (RFC 9207) and carry a code.
  const code = params.get("code");
  if (params.get("iss") !== STALWART.origin || !code || typeof data?.codeVerifier !== "string") return failed(400);

  let label: { clientName: string; redirectHost: string };
  try {
    label = await clientLabel(api, authRequest);
  } catch {
    return failed(400);
  }

  // 4. Exchange the code. Nothing to clean up when this fails.
  let tokens: UpstreamTokens;
  try {
    tokens = await exchangeCode(env, { code, codeVerifier: data.codeVerifier, redirectUri: `${origin}/callback` });
  } catch {
    return failed(502);
  }

  // 5. Identity comes only from Stalwart's JMAP session.
  let session: JmapSession;
  try {
    session = await fetchSession(tokens.accessToken);
  } catch {
    await revokeToken(env, tokens.refreshToken);
    return failed(502);
  }
  const accountId = session.accountId;
  const email = session.username;
  const who = { accountId, email, clientId: authRequest.clientId, clientName: label.clientName };

  // 6. Only a mailbox the MCP endpoint will accept, and staging connects only listed mailboxes.
  const fits = GrantProps.safeParse({ accountId, email }).success && GrantClientId.safeParse(authRequest.clientId).success;
  if (!fits || !signInAllowed(env, email)) {
    await revokeToken(env, tokens.refreshToken);
    await writeAudit(env.DB, { event: "sign_in_refused", outcome: "refused", errorCode: "not_allowed", ...who });
    return refused();
  }

  // 7. A blocked mailbox loses its stored connection too. An unreadable block list fails closed.
  let blocked: boolean;
  try {
    blocked = await isBlocked(env.DB, { accountId, email });
  } catch {
    await revokeToken(env, tokens.refreshToken);
    return failed(500);
  }
  if (blocked) {
    try {
      await vaultFor(env, accountId).wipe("blocked");
    } catch {
      // The block list also refuses every tool call, so a failed wipe does not open access.
    }
    await revokeToken(env, tokens.refreshToken);
    await writeAudit(env.DB, { event: "sign_in_refused", outcome: "refused", errorCode: "blocked", ...who });
    return refused();
  }

  // 8. Store the tokens (also when the user then denies: they may supersede the vault's current
  // ones), then ask on our own page.
  try {
    await vaultFor(env, accountId).storeTokens({ accountId, email, origin, ...tokens });
  } catch {
    await revokeToken(env, tokens.refreshToken);
    return failed(500);
  }
  await writeAudit(env.DB, { event: "sign_in", outcome: "ok", ...who });

  let consent: { handle: string; headers: Headers };
  try {
    consent = await api.beginConsent(authRequest);
    await putPending(env.DB, consent.handle, { ...who, redirectHost: label.redirectHost });
  } catch {
    // The stored tokens stay until the vault's alarm finds no grant for them.
    return failed(500);
  }
  const approveAt = new URL("/approve", origin);
  approveAt.searchParams.set("h", consent.handle);
  return redirect(approveAt.toString(), upstreamHeaders, consent.headers);
}
