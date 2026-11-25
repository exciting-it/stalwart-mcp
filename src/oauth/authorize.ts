/**
 * `GET /authorize`: an AI tool starts a connection. The request is validated by the library,
 * saved server-side with a fresh PKCE verifier, and the browser goes on to Stalwart's sign-in.
 * Nothing here redirects to the AI tool: an invalid request ends on our own page.
 */
import { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { STALWART } from "../stalwart/endpoints";
import { pageLanguage, renderMessagePage } from "./approval-page";

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
  headers.set("Location", to.toString());
  return new Response(null, { status: 302, headers });
}
