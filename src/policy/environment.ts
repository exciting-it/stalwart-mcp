import { httpsOrigin } from "../config";
import type { Env } from "../env";

export function isProduction(env: Pick<Env, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "production";
}

/**
 * Production never trusts the request origin: it answers under `PUBLIC_ORIGIN` only (and throws
 * when that is not an https origin). Staging uses the origin of the request.
 */
export function publicOrigin(env: Pick<Env, "ENVIRONMENT" | "PUBLIC_ORIGIN">, requestUrl: string): string {
  if (!isProduction(env)) return new URL(requestUrl).origin;
  const origin = httpsOrigin(env.PUBLIC_ORIGIN);
  if (origin === null) throw new Error("PUBLIC_ORIGIN is not an https origin");
  return origin;
}

/** The setting that keeps this deployment from serving anything, or null when both are in order. */
export function configProblem(
  env: Pick<Env, "ENVIRONMENT" | "STALWART_ORIGIN" | "PUBLIC_ORIGIN">,
): "STALWART_ORIGIN" | "PUBLIC_ORIGIN" | null {
  if (httpsOrigin(env.STALWART_ORIGIN) === null) return "STALWART_ORIGIN";
  if (isProduction(env) && httpsOrigin(env.PUBLIC_ORIGIN) === null) return "PUBLIC_ORIGIN";
  return null;
}

export function isEnabled(env: Pick<Env, "MAIL_MCP_ENABLED">): boolean {
  return env.MAIL_MCP_ENABLED === "true";
}

function parseList(list: string | undefined): Set<string> {
  return new Set(
    (list ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
}

export function signInAllowed(env: Pick<Env, "ENVIRONMENT" | "SIGNIN_ALLOWLIST">, email: string): boolean {
  if (isProduction(env)) return true;
  return parseList(env.SIGNIN_ALLOWLIST).has(email.trim().toLowerCase());
}

/** Outside production only listed recipients, and never an empty list (staging safety stands on its own). */
export function recipientsAllowed(env: Pick<Env, "ENVIRONMENT" | "SEND_ALLOWLIST">, recipients: string[]): boolean {
  if (isProduction(env)) return true;
  if (recipients.length === 0) return false;
  const allowed = parseList(env.SEND_ALLOWLIST);
  return recipients.every((r) => allowed.has(r.trim().toLowerCase()));
}
