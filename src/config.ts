/**
 * What differs between deployments of this worker: which Stalwart server it serves and what the
 * connector is called. Both are `vars` in `wrangler.jsonc`, set at deploy time and never taken
 * from a request. They are read from the module-level `env` because the Stalwart address is
 * needed deep inside the vault and the JMAP client, where no request is at hand.
 */
import { env } from "cloudflare:workers";
import { MailError } from "./mail";

/**
 * `value` as an origin when it is exactly an https origin as a URL serialises it: lower-case
 * host, no default port, no credentials, path, query or fragment. Anything else is null, so a
 * mistyped setting can never become a looser one.
 */
export function httpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (text !== url.origin && text !== `${url.origin}/`) return null;
  return url.origin;
}

/**
 * The Stalwart server of this deployment. Without a valid `STALWART_ORIGIN` it throws a definite
 * `internal` error: nothing was sent anywhere, so a caller must not treat it as an unknown outcome.
 */
export function stalwartOrigin(): string {
  const origin = httpsOrigin(env.STALWART_ORIGIN);
  if (origin === null) throw new MailError("internal");
  return origin;
}

export const DEFAULT_CONNECTOR_NAME = "Stalwart Mail";
const CONNECTOR_NAME_MAX = 60;

/** The name AI tools show for this connector (`CONNECTOR_NAME`, optional). */
export function connectorName(): string {
  const name = typeof env.CONNECTOR_NAME === "string" ? env.CONNECTOR_NAME.trim() : "";
  return name === "" ? DEFAULT_CONNECTOR_NAME : name.slice(0, CONNECTOR_NAME_MAX);
}
