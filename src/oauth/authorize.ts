/**
 * `GET /authorize`: an AI tool starts a connection. The request is validated by the library and
 * saved server-side with a fresh PKCE verifier. The browser then gets our intro page, which says
 * what is about to happen and links to Stalwart's sign-in; the user goes there with one click.
 * Nothing here redirects to the AI tool: an invalid request ends on our own page.
 */
import { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { STALWART } from "../stalwart/endpoints";
import { pageLanguage, renderIntroPage, renderMessagePage } from "./approval-page";
import { clientLabel } from "./client-label";

/** What `beginUpstream` keeps for the callback; never sent to Stalwart. */
export interface UpstreamData {
  codeVerifier: string;
}

/** Unpadded base64url (RFC 7636 appendix A). */
const B64URL: Record<string, string> = { "+": "-", "/": "_", "=": "" };
const toBase64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/[+/=]/g, (c) => B64URL[c]!);

/** A 256-bit verifier and its S256 challenge. */
async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: toBase64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}

export async function handleAuthorize(request: Request, env: Env, api: OAuthHelpers, origin: string): Promise<Response> {
  const lang = pageLanguage(request);
  const clientId = env.STALWART_OAUTH_CLIENT_ID;
  if (!clientId) return renderMessagePage({ lang, kind: "failed", status: 500 });

  let authRequest;
  try {
    authRequest = await api.parseAuthRequest(request);
  } catch (error) {
    // Never redirect from here, not even to a validated redirect URI: the page is enough.
    const invalid = error instanceof AuthorizationError || error instanceof CimdFetchError;
    return renderMessagePage({ lang, kind: "failed", status: invalid ? 400 : 500 });
  }

  const { verifier, challenge } = await pkcePair();
  const data: UpstreamData = { codeVerifier: verifier };
  const { state, headers } = await api.beginUpstream(authRequest, { data });
  const to = new URL(STALWART.authorize);
  to.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${origin}/callback`,
    scope: STALWART.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  // The page instead of a redirect: users land on a sign-in page they may not know, so it first
  // says whose it is and which login is meant. The cookie that binds the flow to this browser
  // is set here; the link carries exactly what the redirect carried before.
  let label: { clientName: string; redirectHost: string };
  try {
    label = await clientLabel(api, authRequest);
  } catch {
    return renderMessagePage({ lang, kind: "failed", status: 500 });
  }
  const page = renderIntroPage({ lang, ...label, mailHost: new URL(STALWART.origin).host, continueUrl: to.toString() });
  // The flow cookie(s) go onto the page; any other header the library set is taken only where
  // the page has none of its own (both say `no-store`).
  for (const cookie of headers.getSetCookie()) page.headers.append("Set-Cookie", cookie);
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie" && !page.headers.has(name)) page.headers.set(name, value);
  });
  return page;
}
