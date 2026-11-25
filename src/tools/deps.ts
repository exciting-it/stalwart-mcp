import { isBlocked, writeAudit } from "../audit";
import type { Env } from "../env";
import { oauthApi } from "../oauth/options";
import { isEnabled } from "../policy/environment";
import { VaultMailbox } from "../vault/vault-mailbox";
import type { ToolDeps } from "./define-tool";

export function toolDeps(env: Env, origin: string): ToolDeps {
  return {
    enabled: () => isEnabled(env),
    blocked: (g) => isBlocked(env.DB, g),
    mailbox: (g) => new VaultMailbox(env, g.accountId, g.email),
    audit: (e) => writeAudit(env.DB, e),
    async endGrant(accessToken) {
      const api = oauthApi(env, origin);
      const token = await api.unwrapToken(accessToken);
      if (token) await api.revokeGrant(token.grantId, token.userId);
    },
  };
}
