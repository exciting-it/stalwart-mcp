/**
 * The AI tools that already have access to a mailbox, as the approval page shows them, and which
 * of their grants Allow revokes. The page never carries a grant id or a client id: each entry
 * has a key derived on the server from the account id, the consent handle and the client id, and
 * at `POST` the server derives the keys again from a fresh listing of the account's grants. A
 * posted key can therefore only ever match a grant of the account in the pending row.
 */
import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { cleanClientName } from "./client-label";

/** Entries with a checkbox of their own; the tools beyond are one further entry. */
export const SHOWN_TOOLS_MAX = 20;
/** The value of the further entry's checkbox ("these tools stay connected"). */
export const KEEP_REST = "rest";

/** One AI tool's grants for the account: all grants with the same client id. */
export interface ToolGroup {
  clientId: string;
  /** Cleaned and cut; empty when the tool has no usable name. */
  name: string;
  /** The earliest grant's creation time (epoch seconds). */
  since: number;
  grantIds: string[];
}

/** One entry of the page: no id, only the key that stands for it. */
export interface ToolEntry {
  key: string;
  name: string;
  since: number;
}

export interface ConnectedTools {
  /** The connecting tool's own earlier connection: Allow replaces it, so it has no checkbox. */
  replaced: ToolEntry | null;
  /** The other tools, newest first, at most `SHOWN_TOOLS_MAX`; each can stay or be disconnected. */
  others: ToolEntry[];
  /** The keys of the tools beyond those: one entry, decided as a whole. */
  rest: string[];
}

/** What the form posted: the keys shown, the keys kept (`KEEP_REST` for the further entry), the further entry's keys. */
export interface ToolChoice {
  shown: ReadonlySet<string>;
  keep: ReadonlySet<string>;
  rest: ReadonlySet<string>;
}

/** The name a grant was created with (`metadata.clientName`, written at Allow). */
function grantName(grant: GrantSummary): string {
  const raw: unknown = (grant.metadata as { clientName?: unknown } | null | undefined)?.clientName;
  return typeof raw === "string" ? cleanClientName(raw) : "";
}

/** Grants grouped by client id: connected since the earliest, named after the newest; newest tool first. */
export function groupGrants(grants: readonly GrantSummary[]): ToolGroup[] {
  const byClient = new Map<string, { group: ToolGroup; newest: number }>();
  for (const grant of grants) {
    const entry = byClient.get(grant.clientId);
    if (!entry) {
      byClient.set(grant.clientId, {
        group: { clientId: grant.clientId, name: grantName(grant), since: grant.createdAt, grantIds: [grant.id] },
        newest: grant.createdAt,
      });
      continue;
    }
    entry.group.grantIds.push(grant.id);
    entry.group.since = Math.min(entry.group.since, grant.createdAt);
    if (grant.createdAt >= entry.newest) {
      entry.newest = grant.createdAt;
      entry.group.name = grantName(grant);
    }
  }
  return [...byClient.values()]
    .map((e) => e.group)
    .sort((a, b) => b.since - a.since || (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0));
}

/** 32 hex characters: the first half of SHA-256 over the three values, encoded so no two triples meet. */
export async function toolKey(accountId: string, handle: string, clientId: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(["connected-tool", accountId, handle, clientId]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The page's entries for a sign-in of `clientId` into the account, under the consent `handle`. */
export async function connectedTools(
  grants: readonly GrantSummary[],
  at: { accountId: string; handle: string; clientId: string },
): Promise<ConnectedTools> {
  const entry = async (g: ToolGroup): Promise<ToolEntry> => ({
    key: await toolKey(at.accountId, at.handle, g.clientId),
    name: g.name,
    since: g.since,
  });
  const groups = groupGrants(grants);
  const own = groups.find((g) => g.clientId === at.clientId);
  const others = groups.filter((g) => g.clientId !== at.clientId);
  return {
    replaced: own ? await entry(own) : null,
    others: await Promise.all(others.slice(0, SHOWN_TOOLS_MAX).map(entry)),
    rest: await Promise.all(others.slice(SHOWN_TOOLS_MAX).map((g) => toolKey(at.accountId, at.handle, g.clientId))),
  };
}

/**
 * The tools to disconnect: those whose key was posted as shown and not as kept. A grant whose key
 * was not posted as shown (created since the page was rendered, or of a tool the page did not
 * list) is never among them.
 */
export async function toolsToDisconnect(
  grants: readonly GrantSummary[],
  at: { accountId: string; handle: string },
  choice: ToolChoice,
): Promise<ToolGroup[]> {
  if (choice.shown.size === 0) return [];
  const gone: ToolGroup[] = [];
  for (const group of groupGrants(grants)) {
    const key = await toolKey(at.accountId, at.handle, group.clientId);
    if (!choice.shown.has(key)) continue;
    const kept = choice.keep.has(key) || (choice.rest.has(key) && choice.keep.has(KEEP_REST));
    if (!kept) gone.push(group);
  }
  return gone;
}
