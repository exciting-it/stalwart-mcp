import { env } from "cloudflare:workers";
import { MailError } from "../src/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clock } from "../src/clock";
import { STALWART } from "../src/stalwart/endpoints";
import { exchangeCode, InvalidGrantError, refreshTokens, revokeToken } from "../src/stalwart/oauth-client";
import { createFakeStalwart, type FakeStalwart } from "./fake-stalwart";

const A = "a@test.example";
const REDIRECT = "https://worker.example/callback";
const BASIC = `Basic ${btoa("test-client:test-secret")}`;

let fake: FakeStalwart;
beforeEach(() => {
  fake = createFakeStalwart();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

const VERIFIER = "v".repeat(50);

async function codeFor(email: string): Promise<string> {
  return fake.issueCode(email, { codeChallenge: await s256(VERIFIER), redirectUri: REDIRECT });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

async function expectMailError(p: Promise<unknown>, code: string): Promise<void> {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(MailError);
  expect(e).not.toBeInstanceOf(InvalidGrantError);
  expect((e as MailError).code).toBe(code);
}

describe("exchangeCode", () => {
  it("exchanges a code with PKCE verifier, redirect URI and client authentication", async () => {
    vi.spyOn(clock, "now").mockReturnValue(1_000_000);
    const tokens = await exchangeCode(env, { code: await codeFor(A), codeVerifier: VERIFIER, redirectUri: REDIRECT });
    expect(tokens.accessExpiresAt).toBe(1_000_000 + 3600 * 1000);
    expect(tokens.accessToken).not.toBe("");
    expect(tokens.refreshToken).not.toBe(tokens.accessToken);
    expect(fake.knowsToken(tokens.accessToken)).toBe(true);

    const req = fake.requests.find((r) => r.url === STALWART.token)!;
    expect(req.method).toBe("POST");
    expect(req.authorization).toBe(BASIC);
    expect(req.body).toMatchObject({
      grant_type: "authorization_code",
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    });
    // the issued token really belongs to the mailbox
    expect(fake.tokensFor(A).refreshToken).toBe(tokens.refreshToken);
  });

  it("sends the request as form-urlencoded without following redirects", async () => {
    const spy = vi.fn(fake.fetch);
    vi.stubGlobal("fetch", spy);
    await exchangeCode(env, { code: await codeFor(A), codeVerifier: VERIFIER, redirectUri: REDIRECT });
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails as upstream_rejected for a wrong PKCE verifier", async () => {
    await expectMailError(
      exchangeCode(env, { code: await codeFor(A), codeVerifier: "w".repeat(50), redirectUri: REDIRECT }),
      "upstream_rejected",
    );
  });

  it("the fake refuses a code that was issued without a PKCE challenge", async () => {
    // As at Stalwart, PKCE is mandatory: such a code is never redeemable, whatever the verifier.
    const code = fake.issueCode(A, { redirectUri: REDIRECT } as unknown as { codeChallenge: string });
    await expectMailError(exchangeCode(env, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT }), "upstream_rejected");
    expect(fake.revoked(A)).toBe(false);
  });

  it("fails as upstream_rejected for an unknown code", async () => {
    await expectMailError(
      exchangeCode(env, { code: "nope", codeVerifier: VERIFIER, redirectUri: REDIRECT }),
      "upstream_rejected",
    );
  });

  it("fails without storing anything when the answer has no refresh token", async () => {
    fake.omitRefreshTokenOnce();
    await expectMailError(
      exchangeCode(env, { code: await codeFor(A), codeVerifier: VERIFIER, redirectUri: REDIRECT }),
      "upstream_rejected",
    );
  });

  it.each([
    ["http-503", "upstream_unavailable"],
    ["network", "upstream_unavailable"],
    ["invalid-json", "upstream_rejected"],
  ] as const)("maps transport failure %s to %s", async (kind, code) => {
    const c = await codeFor(A);
    fake.failNext(kind);
    await expectMailError(exchangeCode(env, { code: c, codeVerifier: VERIFIER, redirectUri: REDIRECT }), code);
  });
});

describe("refreshTokens", () => {
  async function connect(): Promise<string> {
    const t = await exchangeCode(env, { code: await codeFor(A), codeVerifier: VERIFIER, redirectUri: REDIRECT });
    return t.refreshToken;
  }

  it("refreshes and returns the rotated refresh token", async () => {
    const old = await connect();
    vi.spyOn(clock, "now").mockReturnValue(5_000);
    const next = await refreshTokens(env, old);
    expect(next.refreshToken).not.toBe(old);
    expect(next.accessExpiresAt).toBe(5_000 + 3600 * 1000);
    const req = fake.requests.filter((r) => r.url === STALWART.token).at(-1)!;
    expect(req.authorization).toBe(BASIC);
    expect(req.body).toMatchObject({ grant_type: "refresh_token", refresh_token: old });
    expect(await refreshTokens(env, next.refreshToken)).toMatchObject({ accessExpiresAt: 5_000 + 3_600_000 });
  });

  it("throws InvalidGrantError on invalid_grant", async () => {
    await expect(refreshTokens(env, "unknown-token")).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("throws InvalidGrantError on 400 and on 401 when the body says invalid_grant", async () => {
    for (const status of [400, 401]) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status }));
      await expect(refreshTokens(env, "rt")).rejects.toBeInstanceOf(InvalidGrantError);
    }
  });

  it("is upstream_rejected, not InvalidGrantError, for a 401 invalid_client", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
    await expectMailError(refreshTokens(env, "rt"), "upstream_rejected");
  });

  it("is upstream_rejected, not InvalidGrantError, for a bare 401 and for the fake's 401", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
    await expectMailError(refreshTokens(env, "rt"), "upstream_rejected");
    vi.stubGlobal("fetch", fake.fetch);
    const rt = await connect();
    fake.failNext("http-401");
    await expectMailError(refreshTokens(env, rt), "upstream_rejected");
  });

  it("throws InvalidGrantError for a superseded refresh token", async () => {
    const old = await connect();
    await refreshTokens(env, old);
    await expect(refreshTokens(env, old)).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("is not an InvalidGrantError for a 503", async () => {
    const rt = await connect();
    fake.failNext("http-503");
    await expectMailError(refreshTokens(env, rt), "upstream_unavailable");
  });

  it("is not an InvalidGrantError for a network failure", async () => {
    const rt = await connect();
    fake.failNext("network");
    await expectMailError(refreshTokens(env, rt), "upstream_unavailable");
  });

  it("is not an InvalidGrantError for a timeout", async () => {
    const rt = await connect();
    vi.stubGlobal("fetch", () => Promise.reject(new DOMException("timed out", "TimeoutError")));
    await expectMailError(refreshTokens(env, rt), "upstream_unavailable");
  });

  it("is upstream_rejected, not InvalidGrantError, for unparseable JSON and other 4xx", async () => {
    const rt = await connect();
    fake.failNext("invalid-json");
    await expectMailError(refreshTokens(env, rt), "upstream_rejected");
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }),
    );
    await expectMailError(refreshTokens(env, rt), "upstream_rejected");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 403 }));
    await expectMailError(refreshTokens(env, rt), "upstream_rejected");
  });

  it("keeps upstream text out of the error", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("secret-upstream-detail", { status: 500 }),
    );
    const e = (await rejection(refreshTokens(env, "rt"))) as Error;
    expect(e.message).not.toContain("secret-upstream-detail");
  });
});

describe("revokeToken", () => {
  it("posts the token as a refresh token hint with client authentication", async () => {
    const t = await exchangeCode(env, { code: await codeFor(A), codeVerifier: VERIFIER, redirectUri: REDIRECT });
    await revokeToken(env, t.refreshToken);
    const req = fake.requests.find((r) => r.url === STALWART.revoke)!;
    expect(req.authorization).toBe(BASIC);
    expect(req.body).toMatchObject({ token: t.refreshToken, token_type_hint: "refresh_token" });
    expect(fake.revoked(A)).toBe(true);
  });

  it("never throws, also when Stalwart is down", async () => {
    for (const kind of ["http-503", "http-401", "network", "invalid-json"] as const) {
      fake.failNext(kind);
      await expect(revokeToken(env, "rt")).resolves.toBeUndefined();
    }
    vi.stubGlobal("fetch", () => {
      throw new Error("sync failure");
    });
    await expect(revokeToken(env, "rt")).resolves.toBeUndefined();
  });
});

describe("missing client credentials", () => {
  const cases: Array<[string, Partial<typeof env>]> = [
    ["empty client id", { STALWART_OAUTH_CLIENT_ID: "" }],
    ["missing client id", { STALWART_OAUTH_CLIENT_ID: undefined }],
    ["empty client secret", { STALWART_OAUTH_CLIENT_SECRET: "" }],
  ];
  it.each(cases)("sends no request with %s", async (_name, override) => {
    const broken = { ...env, ...override } as typeof env;
    const code = await codeFor(A);
    fake.requests.length = 0;
    await expectMailError(exchangeCode(broken, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT }), "internal");
    await expectMailError(refreshTokens(broken, "rt"), "internal");
    await expect(revokeToken(broken, "rt")).resolves.toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });
});
