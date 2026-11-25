import { env } from "cloudflare:workers";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { MAIL_LIMITS } from "../src/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseOAuthOptions, grantDirectory, oauthApi } from "../src/oauth/options";

const ORIGIN = "https://t.example";
const REDIRECT = "https://client.example/callback";

afterEach(() => vi.restoreAllMocks());

const clientIds = new Map<string, string>();

/** Creates a client (once per name; the library assigns its id) and a grant for `userId`. */
async function grantFor(userId: string, clientName: string): Promise<void> {
  const api = oauthApi(env, ORIGIN);
  let clientId = clientIds.get(clientName);
  if (!clientId) {
    const client = await api.createClient({ redirectUris: [REDIRECT], tokenEndpointAuthMethod: "none" });
    clientId = client.clientId;
    clientIds.set(clientName, clientId);
  }
  const url = new URL(`${ORIGIN}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "mail",
    state: "s",
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  const request = await api.parseAuthRequest(new Request(url));
  const { redirectTo } = await api.completeAuthorization({
    request,
    userId,
    metadata: {},
    scope: ["mail"],
    props: { accountId: userId },
    revokeExistingGrants: false,
  });
  expect(redirectTo).toContain(REDIRECT);
}

describe("baseOAuthOptions", () => {
  it("pins the lifetimes and endpoints", () => {
    const options = baseOAuthOptions(ORIGIN);
    expect(options).toMatchObject({
      accessTokenTTL: MAIL_LIMITS.accessTokenTtlSeconds,
      refreshTokenTTL: MAIL_LIMITS.refreshIdleSeconds,
      refreshTokenIdleTTL: MAIL_LIMITS.refreshIdleSeconds,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["mail"],
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: "https://t.example/mcp", resource_name: "Test Mail" },
    });
    expect(MAIL_LIMITS.accessTokenTtlSeconds).toBe(3600);
    expect(MAIL_LIMITS.refreshIdleSeconds).toBe(2_592_000);
  });

  it("logs only the error code", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = baseOAuthOptions(ORIGIN).onError!({
      code: "invalid_grant",
      description: "refresh token rt-secret-1234 is bad",
      status: 400,
      headers: {},
      internal: {} as never,
      request: new Request("https://t.example/token?code=secret"),
    });
    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith("oauth_error", "invalid_grant");
  });
});

describe("grantDirectory", () => {
  it("lists and revokes all grants of one mailbox and leaves another mailbox's grants", async () => {
    await grantFor("acctA", "client1");
    await grantFor("acctA", "client2");
    await grantFor("acctB", "client1");
    const dir = grantDirectory(env, ORIGIN);
    expect(await dir.hasGrants("acctA")).toBe(true);
    expect(await dir.revokeAll("acctA")).toBe(2);
    expect(await dir.hasGrants("acctA")).toBe(false);
    expect(await dir.hasGrants("acctB")).toBe(true);
  });

  it("is empty and revokes nothing for a mailbox without grants", async () => {
    const dir = grantDirectory(env, ORIGIN);
    expect(await dir.hasGrants("acctNone")).toBe(false);
    expect(await dir.revokeAll("acctNone")).toBe(0);
  });

  it("pages through all grants", async () => {
    for (let i = 0; i < 5; i++) await grantFor("acctPaged", `paged-${i}`);
    // One grant per page, so the loops have to follow the cursor.
    const dir = grantDirectory(env, ORIGIN, { pageSize: 1 });
    expect(await dir.hasGrants("acctPaged")).toBe(true);
    expect(await dir.revokeAll("acctPaged")).toBe(5);
    expect(await dir.hasGrants("acctPaged")).toBe(false);
  });
});

describe("provider accepts the lifetimes", () => {
  it("a grant expires 30 days after the code exchange, and each refresh moves that to 30 days after it", async () => {
    const DAY = 86_400;
    let nowMs = Date.UTC(2026, 10, 25, 12);
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const api = oauthApi(env, ORIGIN);
    const client = await api.createClient({ redirectUris: [REDIRECT], tokenEndpointAuthMethod: "none" });
    const verifier = "p".repeat(50);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const url = new URL(`${ORIGIN}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT,
      scope: "mail",
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const request = await api.parseAuthRequest(new Request(url));
    const { redirectTo } = await api.completeAuthorization({
      request,
      userId: "acctTokens",
      metadata: {},
      scope: ["mail"],
      props: {},
    });
    const code = new URL(redirectTo).searchParams.get("code")!;

    const provider = new OAuthProvider({
      ...baseOAuthOptions(ORIGIN),
      apiRoute: "/mcp",
      apiHandler: { fetch: async () => new Response("api") },
      defaultHandler: { fetch: async () => new Response("default") },
    });
    const post = (fields: Record<string, string>) =>
      provider.fetch(
        new Request(`${ORIGIN}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: client.clientId, ...fields }).toString(),
        }),
        env,
        { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
      );
    const first = await post({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(first.status).toBe(200);
    const tokens = (await first.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(tokens.expires_in).toBe(3600);
    const grant = async () => {
      const items = (await api.listUserGrants("acctTokens")).items;
      expect(items).toHaveLength(1);
      return items[0]!;
    };
    // Never refreshed: it still expires 30 days after the code exchange.
    expect((await grant()).expiresAt).toBe(nowMs / 1000 + 30 * DAY);

    nowMs += 10 * DAY * 1000;
    const second = await post({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(second.status).toBe(200);
    expect((await grant()).expiresAt).toBe(nowMs / 1000 + 30 * DAY);
  });
});
