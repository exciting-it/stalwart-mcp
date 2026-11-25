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

  // --- bindings ---
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  AUTH_RATE_LIMITER: RateLimit;
  REGISTER_RATE_LIMITER: RateLimit;
  TOKEN_RATE_LIMITER: RateLimit;
  // Untyped here: naming the vault class would make this module import the vault, a cycle.
  // `vaultFor` (the only reader) types the stub.
  MAILBOX_VAULT: DurableObjectNamespace;

  // --- secrets ---
  STALWART_OAUTH_CLIENT_SECRET: string;
  TOKEN_ENC_KEY: string;

  // --- dashboard variables ---
  MAIL_MCP_ENABLED?: string;
  STALWART_OAUTH_CLIENT_ID?: string;
  SIGNIN_ALLOWLIST?: string;
  SEND_ALLOWLIST?: string;
}
