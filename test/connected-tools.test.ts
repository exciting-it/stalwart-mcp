import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import {
  connectedTools,
  groupGrants,
  KEEP_REST,
  SHOWN_TOOLS_MAX,
  toolKey,
  toolsToDisconnect,
} from "../src/oauth/connected-tools";

const ACCOUNT = "acc-1";
const HANDLE = "handle-1";
const DAY = 86_400;
const T0 = Date.UTC(2026, 2, 1) / 1000;

function grant(id: string, clientId: string, createdAt: number, clientName?: unknown): GrantSummary {
  return {
    id,
    clientId,
    userId: ACCOUNT,
    scope: ["mail"],
    metadata: clientName === undefined ? {} : { email: "a@test.example", clientName },
    createdAt,
  };
}

const ids = (groups: { grantIds: string[] }[]) => groups.map((g) => [...g.grantIds].sort());

describe("groupGrants", () => {
  it("makes one group per client id, connected since its earliest grant, named after its newest, newest first", () => {
    const groups = groupGrants([
      grant("g1", "client-n8n", T0, "n8n"),
      grant("g2", "client-claude", T0 + 5 * DAY, "Claude"),
      grant("g3", "client-n8n", T0 + 9 * DAY, "n8n renamed"),
    ]);
    expect(groups.map((g) => g.clientId)).toEqual(["client-claude", "client-n8n"]);
    expect(groups[1]).toEqual({ clientId: "client-n8n", name: "n8n renamed", since: T0, grantIds: ["g1", "g3"] });
    expect(groups[0]).toMatchObject({ name: "Claude", since: T0 + 5 * DAY, grantIds: ["g2"] });
  });

  it("cleans and caps the names a tool registered for itself, and leaves a missing name empty", () => {
    const [script, long, empty, missing, odd] = ["a", "b", "c", "d", "e"].map((c, i) => `client-${c}${i}`) as [
      string,
      string,
      string,
      string,
      string,
    ];
    const groups = groupGrants([
      grant("g1", script, T0 + 5, "<script>x</script>\u200B\u0007"),
      grant("g2", long, T0 + 4, "x".repeat(500)),
      grant("g3", empty, T0 + 3, "   "),
      grant("g4", missing, T0 + 2),
      grant("g5", odd, T0 + 1, 42),
    ]);
    // Escaping is the page's job; here only invisible and control characters go.
    expect(groups.map((g) => g.name)).toEqual(["<script>x</script>", "x".repeat(100), "", "", ""]);
  });
});

describe("toolKey", () => {
  it("is short opaque hex that depends on account, handle and client and never contains the client id", async () => {
    const key = await toolKey(ACCOUNT, HANDLE, "client-n8n");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(await toolKey(ACCOUNT, HANDLE, "client-n8n"));
    const others = await Promise.all([
      toolKey("acc-2", HANDLE, "client-n8n"),
      toolKey(ACCOUNT, "handle-2", "client-n8n"),
      toolKey(ACCOUNT, HANDLE, "client-claude"),
      // A separator inside a value must not make two different triples collide.
      toolKey(`${ACCOUNT}\u0000`, HANDLE.slice(1), "client-n8n"),
    ]);
    expect(new Set([key, ...others]).size).toBe(5);
  });
});

describe("connectedTools", () => {
  it("sets the connecting tool's own earlier connection apart and keys every entry", async () => {
    const grants = [
      grant("g1", "client-n8n", T0, "n8n"),
      grant("g2", "client-claude", T0 + DAY, "Claude"),
      grant("g3", "client-claude", T0 + 2 * DAY, "Claude"),
      grant("g4", "client-other", T0 + 3 * DAY, ""),
    ];
    const tools = await connectedTools(grants, { accountId: ACCOUNT, handle: HANDLE, clientId: "client-claude" });
    expect(tools.replaced).toEqual({ key: await toolKey(ACCOUNT, HANDLE, "client-claude"), name: "Claude", since: T0 + DAY });
    expect(tools.others).toEqual([
      { key: await toolKey(ACCOUNT, HANDLE, "client-other"), name: "", since: T0 + 3 * DAY },
      { key: await toolKey(ACCOUNT, HANDLE, "client-n8n"), name: "n8n", since: T0 },
    ]);
    expect(tools.rest).toEqual([]);
    expect(JSON.stringify(tools)).not.toMatch(/client-|g\d/);
  });

  it("has no entries without grants, and none for the connecting tool alone when it has none", async () => {
    expect(await connectedTools([], { accountId: ACCOUNT, handle: HANDLE, clientId: "client-claude" })).toEqual({
      replaced: null,
      others: [],
      rest: [],
    });
  });

  it("shows at most 20 other tools, newest first; the rest are keys of one further entry", async () => {
    const grants = Array.from({ length: 23 }, (_, i) => grant(`g${i}`, `client-${i}`, T0 + i * DAY, `Tool ${i}`));
    const tools = await connectedTools(grants, { accountId: ACCOUNT, handle: HANDLE, clientId: "client-new" });
    expect(SHOWN_TOOLS_MAX).toBe(20);
    expect(tools.others.map((t) => t.name)).toEqual(Array.from({ length: 20 }, (_, i) => `Tool ${22 - i}`));
    expect(tools.rest).toEqual(await Promise.all([2, 1, 0].map((i) => toolKey(ACCOUNT, HANDLE, `client-${i}`))));
  });
});

describe("toolsToDisconnect", () => {
  const grants = [
    grant("g1", "client-n8n", T0, "n8n"),
    grant("g2", "client-n8n", T0 + DAY, "n8n"),
    grant("g3", "client-claude", T0 + 2 * DAY, "Claude"),
  ];
  const at = { accountId: ACCOUNT, handle: HANDLE };
  const key = (clientId: string) => toolKey(ACCOUNT, HANDLE, clientId);

  it("disconnects exactly the tools that were shown and not kept, with all of their grants", async () => {
    const shown = new Set([await key("client-n8n"), await key("client-claude")]);
    const none = await toolsToDisconnect(grants, at, { shown, keep: shown, rest: new Set() });
    expect(none).toEqual([]);
    const gone = await toolsToDisconnect(grants, at, { shown, keep: new Set([await key("client-claude")]), rest: new Set() });
    expect(gone.map((g) => [g.clientId, g.name])).toEqual([["client-n8n", "n8n"]]);
    expect(ids(gone)).toEqual([["g1", "g2"]]);
  });

  it("decides the further entry as a whole", async () => {
    const restKeys = new Set([await key("client-n8n"), await key("client-claude")]);
    const kept = await toolsToDisconnect(grants, at, { shown: restKeys, keep: new Set([KEEP_REST]), rest: restKeys });
    expect(kept).toEqual([]);
    const gone = await toolsToDisconnect(grants, at, { shown: restKeys, keep: new Set(), rest: restKeys });
    expect(ids(gone)).toEqual([["g3"], ["g1", "g2"]]);
  });

  it("leaves alone every grant whose key was not posted as shown", async () => {
    const forged = new Set([
      "0".repeat(32),
      await toolKey("acc-2", HANDLE, "client-n8n"),
      await toolKey(ACCOUNT, "handle-2", "client-n8n"),
      "client-n8n",
      "g1",
    ]);
    expect(await toolsToDisconnect(grants, at, { shown: forged, keep: new Set(), rest: forged })).toEqual([]);
  });
});
