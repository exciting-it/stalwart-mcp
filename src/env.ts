export interface Env {
  // --- deployment constants (`vars` in wrangler.jsonc) ---
  ENVIRONMENT: "production" | "staging";
  /** The Stalwart server, as an https origin, e.g. `https://mail.example.com`. */
  STALWART_ORIGIN: string;
  /** This worker's own public https origin. Required in production, unused in staging. */
  PUBLIC_ORIGIN?: string;
  /** The name AI tools show for the connector. Optional. */
  CONNECTOR_NAME?: string;
  /**
   * Restricts where the mailbox vaults run and store data: `eu`, `us` or `fedramp`. Optional. Must be
   * chosen before the first sign-in: vault ids depend on it, so a later change orphans every
   * stored connection.
   */
  DATA_JURISDICTION?: string;
  /**
   * Areas to switch off: a comma-separated list of `contacts` and `calendars`. Optional; without
   * it the connector offers mail, contacts and calendars. Each area that is on adds a scope to
   * what is asked of Stalwart, so a mailbox connected while an area was off has to connect
   * again to use it.
   */
  DISABLED_FEATURES?: string;

  // --- bindings ---
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  AUTH_RATE_LIMITER: RateLimit;
  REGISTER_RATE_LIMITER: RateLimit;
  TOKEN_RATE_LIMITER: RateLimit;
  // Untyped here: naming the vault class would make this module import the vault, a cycle.
  // `vaultFor` (the only reader) types the stub.
  MAILBOX_VAULT: DurableObjectNamespace;

  // --- secrets (the worker answers 503 until both are set) ---
  STALWART_OAUTH_CLIENT_SECRET: string;
  TOKEN_ENC_KEY: string;

  // --- dashboard variables ---
  /** Required like the secrets: the worker answers 503 until it is set. */
  STALWART_OAUTH_CLIENT_ID?: string;
  SIGNIN_ALLOWLIST?: string;
  SEND_ALLOWLIST?: string;
}
