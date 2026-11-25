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

/** Where Cloudflare may run and store the mailbox vaults, when restricted. */
const DATA_JURISDICTIONS: readonly string[] = ["eu", "us", "fedramp"] satisfies DurableObjectJurisdiction[];

/**
 * `DATA_JURISDICTION` as Cloudflare's jurisdiction: undefined when it is not set (no
 * restriction), null when it names something Cloudflare does not offer here.
 */
export function dataJurisdiction(value: unknown): DurableObjectJurisdiction | undefined | null {
  if (value === undefined || value === "") return undefined;
  return typeof value === "string" && DATA_JURISDICTIONS.includes(value) ? (value as DurableObjectJurisdiction) : null;
}

/** What a deployment can offer beyond mail. Each area needs its own scope at Stalwart. */
export const AREAS = ["contacts", "calendars"] as const;
export type Area = (typeof AREAS)[number];

/**
 * `FEATURES` as a set of areas: empty when it is not set (mail only), null when it names
 * something this worker does not know.
 */
export function parseFeatures(value: unknown): ReadonlySet<Area> | null {
  if (value === undefined || value === "") return new Set();
  if (typeof value !== "string") return null;
  const areas = new Set<Area>();
  for (const part of value.split(",")) {
    const name = part.trim();
    if (!(AREAS as readonly string[]).includes(name)) return null;
    areas.add(name as Area);
  }
  return areas;
}

/**
 * The areas beyond mail this deployment offers (`FEATURES`). They decide which scopes are asked
 * of Stalwart, which tools exist and what the approval page says. A setting that is not valid
 * offers none; `configProblem` closes the worker for it anyway.
 */
export function features(): ReadonlySet<Area> {
  return parseFeatures(env.FEATURES) ?? new Set();
}

export const DEFAULT_CONNECTOR_NAME = "Stalwart Mail";
const CONNECTOR_NAME_MAX = 60;

/** The name AI tools show for this connector (`CONNECTOR_NAME`, optional). */
export function connectorName(): string {
  const name = typeof env.CONNECTOR_NAME === "string" ? env.CONNECTOR_NAME.trim() : "";
  return name === "" ? DEFAULT_CONNECTOR_NAME : name.slice(0, CONNECTOR_NAME_MAX);
}
