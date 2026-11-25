import { stalwartOrigin } from "../config";

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
  scope: "urn:ietf:params:oauth:scope:mail",
} as const;
