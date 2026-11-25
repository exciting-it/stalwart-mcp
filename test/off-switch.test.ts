import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("off switch", () => {
  it.each(["/mcp", "/authorize", "/token", "/register", "/.well-known/oauth-authorization-server", "/approve"])(
    "answers 503 on %s when switched off",
    async (path) => {
      const res = await worker.fetch(
        new Request(`https://t.example${path}`),
        { ...env, MAIL_MCP_ENABLED: "false" },
        createExecutionContext(),
      );
      expect(res.status).toBe(503);
    },
  );

  it.each([
    ["no Stalwart address", { STALWART_ORIGIN: undefined }, "STALWART_ORIGIN"],
    ["a Stalwart address that is not https", { STALWART_ORIGIN: "http://stalwart.test.example" }, "STALWART_ORIGIN"],
    ["a Stalwart address with a path", { STALWART_ORIGIN: "https://stalwart.test.example/jmap" }, "STALWART_ORIGIN"],
    ["production without its own address", { ENVIRONMENT: "production" }, "PUBLIC_ORIGIN"],
  ] as const)("answers 503 on every path with %s", async (_case, override, setting) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/mcp", "/authorize", "/token", "/register", "/.well-known/oauth-authorization-server"]) {
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

  it("answers 404 instead of 503 when switched on and the route is unknown", async () => {
    const res = await worker.fetch(new Request("https://t.example/nope"), env, createExecutionContext());
    expect(res.status).toBe(404);
  });

  it("applies the D1 migration in tests", async () => {
    expect((await env.DB.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>())?.n).toBe(0);
  });
});
