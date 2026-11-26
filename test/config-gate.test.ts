import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("configuration gate", () => {
  it.each([
    ["no Stalwart address", { STALWART_ORIGIN: undefined }, "STALWART_ORIGIN"],
    ["a Stalwart address that is not https", { STALWART_ORIGIN: "http://stalwart.test.example" }, "STALWART_ORIGIN"],
    ["a Stalwart address with a path", { STALWART_ORIGIN: "https://stalwart.test.example/jmap" }, "STALWART_ORIGIN"],
    ["production without its own address", { ENVIRONMENT: "production" }, "PUBLIC_ORIGIN"],
    ["a data location Cloudflare does not offer", { DATA_JURISDICTION: "europe" }, "DATA_JURISDICTION"],
    ["an area the worker does not know", { DISABLED_FEATURES: "contacts,files" }, "DISABLED_FEATURES"],
    ["mail in the list of areas to switch off", { DISABLED_FEATURES: "mail" }, "DISABLED_FEATURES"],
    ["no OAuth client id", { STALWART_OAUTH_CLIENT_ID: undefined }, "STALWART_OAUTH_CLIENT_ID"],
    ["an empty OAuth client id", { STALWART_OAUTH_CLIENT_ID: " " }, "STALWART_OAUTH_CLIENT_ID"],
    ["no OAuth client secret", { STALWART_OAUTH_CLIENT_SECRET: undefined }, "STALWART_OAUTH_CLIENT_SECRET"],
    ["no token key", { TOKEN_ENC_KEY: undefined }, "TOKEN_ENC_KEY"],
  ] as const)("answers 503 on every path with %s", async (_case, override, setting) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/mcp", "/authorize", "/token", "/register", "/.well-known/oauth-authorization-server", "/approve"]) {
      const res = await worker.fetch(
        new Request(`https://t.example${path}`),
        { ...env, ...override } as typeof env,
        createExecutionContext(),
      );
      expect(res.status).toBe(503);
    }
    expect(log).toHaveBeenCalledWith("config_error", setting);
    log.mockRestore();
  });

  it("production serves under PUBLIC_ORIGIN and under no other host", async () => {
    const production = { ...env, ENVIRONMENT: "production", PUBLIC_ORIGIN: "https://connector.test.example" } as const;
    const get = (url: string) => worker.fetch(new Request(url), production, createExecutionContext());

    const meta = await get("https://connector.test.example/.well-known/oauth-authorization-server");
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      issuer: "https://connector.test.example",
      token_endpoint: "https://connector.test.example/token",
    });
    const resource = await get("https://connector.test.example/.well-known/oauth-protected-resource/mcp");
    expect(await resource.json()).toMatchObject({ resource: "https://connector.test.example/mcp" });

    for (const path of ["/.well-known/oauth-authorization-server", "/mcp", "/authorize", "/token", "/register"]) {
      expect((await get(`https://evil.example${path}`)).status).toBe(404);
    }
  });

  it("answers 404 instead of 503 when configured and the route is unknown", async () => {
    const res = await worker.fetch(new Request("https://t.example/nope"), env, createExecutionContext());
    expect(res.status).toBe(404);
  });

  it("applies the D1 migration in tests", async () => {
    expect((await env.DB.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>())?.n).toBe(0);
  });
});
