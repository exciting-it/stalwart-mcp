/** How the pages name the AI tool that is connecting: its own name, cleaned, and its redirect host. */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { cleanText } from "../content/sanitize";

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
export async function clientLabel(
  api: OAuthHelpers,
  authRequest: AuthRequest,
): Promise<{ clientName: string; redirectHost: string }> {
  const redirectHost = redirectHostOf(authRequest.redirectUri);
  const client = await api.lookupClient(authRequest.clientId);
  const name = cleanText(client?.clientName ?? "", CLIENT_NAME_MAX).text.trim();
  return { clientName: name === "" ? redirectHost : name, redirectHost };
}
