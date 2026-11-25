// Types the module-level `env` of "cloudflare:workers" as this worker's Env.
import type { Env as WorkerEnv } from "./env";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- adds WorkerEnv's members
    interface Env extends WorkerEnv {}
  }
}
