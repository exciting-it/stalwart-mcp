import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { MailError } from "../src/mail";
import { vaultFor } from "../src/vault/mailbox-vault";

/**
 * The local runtime (workerd) does not implement jurisdictions, so the restricted case runs
 * against a namespace that records how it was asked. That the vaults really stay in the
 * jurisdiction is a live check on a deployed worker (README).
 */
function recordingNamespace() {
  const calls: string[] = [];
  const space = (label: string) => ({
    jurisdiction(j: string) {
      calls.push(`${label}.jurisdiction(${j})`);
      return space(`${label}[${j}]`);
    },
    idFromName(name: string) {
      calls.push(`${label}.idFromName(${name})`);
      return `${label}:${name}`;
    },
    get(id: string) {
      calls.push(`${label}.get(${id})`);
      return { id };
    },
  });
  return { namespace: space("vaults"), calls };
}

const envWith = (namespace: unknown, jurisdiction?: string): Env =>
  ({ MAILBOX_VAULT: namespace, DATA_JURISDICTION: jurisdiction }) as unknown as Env;

describe("vault data location (DATA_JURISDICTION)", () => {
  it("without the setting, the vault is the plain object of the account id", () => {
    const stub = vaultFor(env, "acct-plain");
    expect(stub.id.equals(env.MAILBOX_VAULT.idFromName("acct-plain"))).toBe(true);

    const { namespace, calls } = recordingNamespace();
    vaultFor(envWith(namespace), "acct-1");
    vaultFor(envWith(namespace, ""), "acct-2");
    expect(calls.filter((c) => c.includes("jurisdiction"))).toEqual([]);
  });

  it.each(["eu", "us", "fedramp"])("with %s, id and stub both come from the restricted namespace", (jurisdiction) => {
    const { namespace, calls } = recordingNamespace();
    const stub = vaultFor(envWith(namespace, jurisdiction), "acct-1") as unknown as { id: string };
    expect(calls).toEqual([
      `vaults.jurisdiction(${jurisdiction})`,
      `vaults[${jurisdiction}].idFromName(acct-1)`,
      `vaults[${jurisdiction}].get(vaults[${jurisdiction}]:acct-1)`,
    ]);
    expect(stub.id).toBe(`vaults[${jurisdiction}]:acct-1`);
  });

  it("a mistyped jurisdiction reaches no vault at all", () => {
    const { namespace, calls } = recordingNamespace();
    expect(() => vaultFor(envWith(namespace, "europe"), "acct-x")).toThrow(MailError);
    expect(calls).toEqual([]);
  });
});
