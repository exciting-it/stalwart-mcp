// Adds the test-only binding injected by vitest.config.ts (miniflare bindings) to the `env`
// that src/cloudflare-env.d.ts types.
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
