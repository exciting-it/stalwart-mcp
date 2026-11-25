import { AREAS, type Area, features, stalwartOrigin } from "../config";

const MAIL_SCOPE = "urn:ietf:params:oauth:scope:mail";
const AREA_SCOPE: Record<Area, string> = {
  contacts: "urn:ietf:params:oauth:scope:contacts",
  calendars: "urn:ietf:params:oauth:scope:calendars",
};

/**
 * The one Stalwart server this worker talks to (`STALWART_ORIGIN`). Every upstream URL is
 * derived from here; the paths are Stalwart's own and the same on every server.
 */
export const STALWART = {
  get origin(): string {
    return stalwartOrigin();
  },
  get authorize(): string {
    return `${stalwartOrigin()}/login`;
  },
  get token(): string {
    return `${stalwartOrigin()}/auth/token`;
  },
  get revoke(): string {
    return `${stalwartOrigin()}/auth/revoke`;
  },
  get session(): string {
    return `${stalwartOrigin()}/jmap/session`;
  },
  /** Mail always; one more scope for each area in `FEATURES`. Never more than the deployment offers. */
  get scope(): string {
    return [MAIL_SCOPE, ...AREAS.filter((area) => features().has(area)).map((area) => AREA_SCOPE[area])].join(" ");
  },
} as const;
