import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { purgeAudit } from "./audit";
import type { Env } from "./env";
import { createMcpHandler } from "./mcp/handler";
import { handleApprove } from "./oauth/approve";
import { handleAuthorize } from "./oauth/authorize";
import { handleCallback } from "./oauth/callback";
import { baseOAuthOptions, oauthApi } from "./oauth/options";
import { configProblem, isEnabled, publicOrigin } from "./policy/environment";
import { toolDeps } from "./tools/deps";

export { MailboxVault } from "./vault/mailbox-vault";

/** The unauthenticated endpoints and their per-address limiter. `/mcp` is limited per mailbox in the vault. */
const LIMITER_BY_PATH: Record<string, "AUTH_RATE_LIMITER" | "REGISTER_RATE_LIMITER" | "TOKEN_RATE_LIMITER"> = {
  "/authorize": "AUTH_RATE_LIMITER",
  "/callback": "AUTH_RATE_LIMITER",
  "/approve": "AUTH_RATE_LIMITER",
  "/register": "REGISTER_RATE_LIMITER",
  "/token": "TOKEN_RATE_LIMITER",
};

async function rateLimited(request: Request, env: Env): Promise<boolean> {
  const limiter = LIMITER_BY_PATH[new URL(request.url).pathname];
  if (!limiter) return false;
  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env[limiter].limit({ key });
  return !success;
}

/**
 * The browser part of the flow. The helpers are built for the public origin of this request,
 * not taken from `env.OAUTH_PROVIDER`: the library sets that once per `env` object, so with
 * several origins (staging) it could carry another origin's resource.
 */
function defaultHandlerFor(origin: string): ExportedHandler<Env> & Pick<Required<ExportedHandler<Env>>, "fetch"> {
  return {
    async fetch(request, env) {
      const api = oauthApi(env, origin);
      const { pathname } = new URL(request.url);
      if (pathname === "/authorize" && request.method === "GET") return handleAuthorize(request, env, api, origin);
      if (pathname === "/callback" && request.method === "GET") return handleCallback(request, env, api, origin);
      if (pathname === "/approve") return handleApprove(request, env, api);
      return new Response("Not found", { status: 404 });
    },
  };
}

const OAUTH_PURGE_ROUNDS = 10;

/** The provider the daily purge runs on. It touches only KV records; this origin is never served. */
const PURGE_ORIGIN = "https://purge.invalid";

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      ...baseOAuthOptions(origin),
      apiRoute: "/mcp",
      apiHandler: createMcpHandler((env) => toolDeps(env, origin)),
      defaultHandler: defaultHandlerFor(origin),
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!isEnabled(env)) return new Response("Service unavailable", { status: 503 });
    const problem = configProblem(env);
    if (problem !== null) {
      // A missing or malformed address closes the worker instead of guessing one.
      console.error("config_error", problem);
      return new Response("Service unavailable", { status: 503 });
    }
    // Production serves one origin. The OAuth library builds its issuer and endpoint URLs from
    // the request, so a request under any other host (a route that `PUBLIC_ORIGIN` does not
    // match) would hand out metadata that contradicts the configured resource.
    const origin = publicOrigin(env, request.url);
    if (new URL(request.url).origin !== origin) return new Response("Not found", { status: 404 });
    if (await rateLimited(request, env)) return new Response("Too many requests", { status: 429 });
    return providerFor(origin).fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await purgeAudit(env.DB);
    } catch {
      console.error("scheduled_purge_failed", "audit");
    }
    try {
      // Each round checks one batch; the next one continues from its cursor, until the sweep is
      // done or 10 rounds ran.
      const provider = providerFor(PURGE_ORIGIN);
      let cursor: string | undefined;
      for (let round = 0; round < OAUTH_PURGE_ROUNDS; round++) {
        const result = await provider.purgeExpiredData(env, cursor === undefined ? undefined : { cursor });
        if (result.done || result.cursor === undefined) break;
        cursor = result.cursor;
      }
    } catch {
      console.error("scheduled_purge_failed", "oauth");
    }
  },
} satisfies ExportedHandler<Env>;
