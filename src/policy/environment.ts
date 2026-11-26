import { dataJurisdiction, enabledAreas, httpsOrigin } from "../config";
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

/** What the worker cannot run without. Until all three are set it serves nothing. */
const REQUIRED = ["STALWART_OAUTH_CLIENT_ID", "STALWART_OAUTH_CLIENT_SECRET", "TOKEN_ENC_KEY"] as const;

export type ConfigSetting =
  | "STALWART_ORIGIN"
  | "PUBLIC_ORIGIN"
  | "DATA_JURISDICTION"
  | "DISABLED_FEATURES"
  | (typeof REQUIRED)[number];

/** The setting that keeps this deployment from serving anything, or null when all are in order. */
export function configProblem(env: Pick<Env, "ENVIRONMENT" | ConfigSetting>): ConfigSetting | null {
  if (httpsOrigin(env.STALWART_ORIGIN) === null) return "STALWART_ORIGIN";
  if (isProduction(env) && httpsOrigin(env.PUBLIC_ORIGIN) === null) return "PUBLIC_ORIGIN";
  // A mistyped jurisdiction must not quietly become "no restriction".
  if (dataJurisdiction(env.DATA_JURISDICTION) === null) return "DATA_JURISDICTION";
  // A mistyped area must not quietly ask Stalwart for more than intended.
  if (enabledAreas(env.DISABLED_FEATURES) === null) return "DISABLED_FEATURES";
  // A freshly created worker stays closed until its client and its key are in place.
  for (const name of REQUIRED) {
    const value: unknown = env[name];
    if (typeof value !== "string" || value.trim() === "") return name;
  }
  return null;
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
