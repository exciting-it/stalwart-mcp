import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { nextIp } from "./oauth-flow";

type LimiterName = "AUTH_RATE_LIMITER" | "REGISTER_RATE_LIMITER" | "TOKEN_RATE_LIMITER";

async function fetchWith(path: string, e: Env, ip: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://mail-mcp.test.example${path}`, { method: path === "/register" || path === "/token" ? "POST" : "GET", headers: { "cf-connecting-ip": ip } }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** `env` with every limiter replaced by one that refuses and records its use. */
function refusingLimiters(): { env: Env; used: LimiterName[] } {
  const used: LimiterName[] = [];
  const limiter = (name: LimiterName): RateLimit => ({
    limit: async () => {
      used.push(name);
      return { success: false };
    },
  });
  return {
    used,
    env: {
      ...env,
      AUTH_RATE_LIMITER: limiter("AUTH_RATE_LIMITER"),
      REGISTER_RATE_LIMITER: limiter("REGISTER_RATE_LIMITER"),
      TOKEN_RATE_LIMITER: limiter("TOKEN_RATE_LIMITER"),
    },
  };
}

describe("rate limits", () => {
  it.each<[string, LimiterName]>([
    ["/register", "REGISTER_RATE_LIMITER"],
    ["/token", "TOKEN_RATE_LIMITER"],
    ["/authorize", "AUTH_RATE_LIMITER"],
    ["/callback", "AUTH_RATE_LIMITER"],
    ["/approve", "AUTH_RATE_LIMITER"],
  ])("%s is limited by %s only", async (path, limiter) => {
    const t = refusingLimiters();
    expect((await fetchWith(path, t.env, nextIp())).status).toBe(429);
    expect(t.used).toEqual([limiter]);
  });

  it.each(["/mcp", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"])(
    "%s is not limited per address",
    async (path) => {
      const t = refusingLimiters();
      expect((await fetchWith(path, t.env, nextIp())).status).not.toBe(429);
      expect(t.used).toEqual([]);
    },
  );

  it.each<[string, number]>([
    ["/register", 20],
    ["/token", 120],
    ["/authorize", 30],
    ["/callback", 30],
    ["/approve", 30],
  ])("%s answers 429 to request %i + 1 per minute from one address", async (path, limit) => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i <= limit; i++) statuses.push((await fetchWith(path, env, ip)).status);
    expect(statuses.slice(0, limit).includes(429)).toBe(false);
    expect(statuses[limit]).toBe(429);
  });
});
