/** Options of the OAuth server this worker presents to AI tools, and the grant directory built on it. */
import { getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { MAIL_LIMITS } from "../mail";
import { connectorName } from "../config";
import type { Env } from "../env";

/** Never dispatched to: `getOAuthApi` only returns helpers, it does not serve requests. */
const INERT = { fetch: async (): Promise<Response> => new Response(null, { status: 404 }) };

export function baseOAuthOptions(
  origin: string,
): Omit<OAuthProviderOptions<Env>, "defaultHandler" | "apiRoute" | "apiHandler"> {
  return {
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    accessTokenTTL: MAIL_LIMITS.accessTokenTtlSeconds,
    // A new grant expires 30 days after the code exchange; every refresh moves that to 30 days
    // after the refresh. So a grant lives as long as the client keeps using it and ends after 30
    // idle days, also one that is never refreshed (`undefined` here would mean no expiry at all).
    refreshTokenTTL: MAIL_LIMITS.refreshIdleSeconds,
    refreshTokenIdleTTL: MAIL_LIMITS.refreshIdleSeconds,
    scopesSupported: ["mail"],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: connectorName() },
    // The code only: the description and the request can carry tokens or client input.
    onError: ({ code }) => {
      console.error("oauth_error", code);
    },
  };
}

export function oauthApi(env: Env, origin: string): OAuthHelpers {
  return getOAuthApi(
    { ...baseOAuthOptions(origin), apiRoute: "/mcp", apiHandler: INERT, defaultHandler: INERT },
    env,
  );
}

/** The Worker grants (AI tool connections) of a mailbox; the grant's user id is the mailbox's account id. */
export interface GrantDirectory {
  hasGrants(accountId: string): Promise<boolean>;
  revokeAll(accountId: string): Promise<number>;
}

const DEFAULT_PAGE_SIZE = 100;

export function grantDirectory(env: Env, origin: string, options: { pageSize?: number } = {}): GrantDirectory {
  const api = oauthApi(env, origin);
  const limit = options.pageSize ?? DEFAULT_PAGE_SIZE;

  return {
    async hasGrants(accountId) {
      let cursor: string | undefined;
      do {
        const page = await api.listUserGrants(accountId, { limit, cursor });
        if (page.items.length > 0) return true;
        cursor = page.cursor;
      } while (cursor);
      return false;
    },

    async revokeAll(accountId) {
      let revoked = 0;
      // Revoking while paging could skip entries, so first collect every id, then revoke.
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.listUserGrants(accountId, { limit, cursor });
        ids.push(...page.items.map((g) => g.id));
        cursor = page.cursor;
      } while (cursor);
      for (const id of ids) {
        await api.revokeGrant(id, accountId);
        revoked++;
      }
      return revoked;
    },
  };
}
