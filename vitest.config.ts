import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Paths are relative to the repo root, where vitest is run from.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.resolve("migrations")),
          // Tests run as a test deployment: any origin is served, the allow-lists below apply.
          ENVIRONMENT: "staging",
          // Never the address named in wrangler.jsonc: a test that runs as production names its own.
          PUBLIC_ORIGIN: "",
          // Never the server named in wrangler.jsonc: tests run against test/fake-stalwart.ts.
          STALWART_ORIGIN: "https://stalwart.test.example",
          CONNECTOR_NAME: "Test Mail",
          // The local runtime does not implement jurisdictions; tests run without one.
          DATA_JURISDICTION: "",
          // Nothing switched off, so all tools are under test.
          DISABLED_FEATURES: "",
          STALWART_OAUTH_CLIENT_ID: "test-client",
          STALWART_OAUTH_CLIENT_SECRET: "test-secret",
          // Test value (base64 of 32 zero bytes), not a secret.
          TOKEN_ENC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          SIGNIN_ALLOWLIST: "a@test.example,b@test.example",
          SEND_ALLOWLIST: "ok@test.example",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
