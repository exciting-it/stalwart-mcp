/**
 * `/approve`: our own consent page, shown after Stalwart's sign-in so it can name the mailbox.
 * GET only renders. POST decides; the handle works once and only in the browser that started
 * the flow (the library's `__Host-` cookie). Only Allow creates a Worker grant, and only Allow
 * disconnects the tools the user unticked on the page.
 */
import { features } from "../config";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { isBlocked, writeAudit } from "../audit";
import type { Env } from "../env";
import { vaultFor } from "../vault/mailbox-vault";
import { pageLanguage, renderApprovalPage, renderMessagePage } from "./approval-page";
import { connectedTools, type ConnectedTools, type ToolChoice, toolsToDisconnect } from "./connected-tools";
import { listGrants } from "./options";
import { peekPending, takePending } from "./pending";

function redirect(headers: Headers, location: string): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

export async function handleApprove(request: Request, env: Env, api: OAuthHelpers): Promise<Response> {
  const lang = pageLanguage(request);
  const page = (kind: "refused" | "failed" | "expired", status: number) => renderMessagePage({ lang, kind, status });

  if (request.method === "GET") {
    const handle = new URL(request.url).searchParams.get("h") ?? "";
    const pending = handle === "" ? null : await peekPending(env.DB, handle);
    if (!pending) return page("expired", 410);
    // The user decides about the tools that already have access; a page that cannot name them is not shown.
    let tools: ConnectedTools;
    try {
      const at = { accountId: pending.accountId, handle, clientId: pending.clientId };
      tools = await connectedTools(await listGrants(api, pending.accountId), at);
    } catch {
      return page("failed", 500);
    }
    return renderApprovalPage({
      lang,
      clientName: pending.clientName,
      redirectHost: pending.redirectHost,
      email: pending.email,
      handle,
      areas: features(),
      tools,
    });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

  let handle: string;
  let decision: string;
  let choice: ToolChoice;
  try {
    const form = await request.formData();
    handle = String(form.get("h") ?? "");
    decision = String(form.get("decision") ?? "");
    const keys = (name: string) => new Set(form.getAll(name).filter((v): v is string => typeof v === "string"));
    choice = { shown: keys("shown"), keep: keys("keep"), rest: keys("rest") };
  } catch {
    return page("failed", 400);
  }

  if (decision !== "allow") {
    let denied;
    try {
      denied = await api.denyConsent(request, handle);
    } catch {
      return page("failed", 400);
    }
    const pending = await takePending(env.DB, handle);
    await writeAudit(env.DB, {
      event: "approval_denied",
      outcome: "ok",
      accountId: pending?.accountId,
      email: pending?.email,
      clientId: denied.request.clientId,
      clientName: pending?.clientName,
    });
    return redirect(denied.headers, denied.redirectTo);
  }

  let approved;
  try {
    approved = await api.approveConsent(request, handle);
  } catch {
    return page("failed", 400);
  }
  const pending = await takePending(env.DB, handle);
  if (!pending) return page("expired", 410);
  // The pending row and the approved request must describe the same AI tool.
  if (pending.clientId !== approved.request.clientId) return page("failed", 400);

  const { accountId, email, clientName } = pending;
  const who = { accountId, email, clientId: approved.request.clientId, clientName };
  let blocked: boolean;
  try {
    blocked = await isBlocked(env.DB, { accountId, email });
  } catch {
    return page("failed", 500);
  }
  if (blocked) {
    // Blocked since the callback: the connection stored there goes too, as at the callback.
    try {
      await vaultFor(env, accountId).wipe("blocked");
    } catch {
      // The block list also refuses every tool call, so a failed wipe does not open access.
    }
    await writeAudit(env.DB, { event: "sign_in_refused", outcome: "refused", errorCode: "blocked", ...who });
    return page("refused", 403);
  }
  // No grant for a mailbox whose vault holds no connection (wiped since the callback).
  try {
    if (!(await vaultFor(env, accountId).status()).connected) return page("expired", 410);
  } catch {
    return page("failed", 500);
  }

  // The tools the user unticked lose their grants before the new one exists, so the new grant is
  // never among them. Keys only resolve against this account's grants, listed afresh; a grant
  // the page did not show stays. If any revocation fails, nothing is granted.
  try {
    if (choice.shown.size > 0) {
      const gone = await toolsToDisconnect(await listGrants(api, accountId), { accountId, handle }, choice);
      for (const tool of gone) {
        for (const id of tool.grantIds) await api.revokeGrant(id, accountId);
        await writeAudit(env.DB, {
          event: "connection_removed",
          outcome: "ok",
          accountId,
          email,
          clientId: tool.clientId,
          clientName: tool.name,
          resultCount: tool.grantIds.length,
        });
      }
    }
  } catch {
    return page("failed", 500);
  }

  let redirectTo: string;
  try {
    ({ redirectTo } = await api.completeAuthorization({
      request: approved.request,
      userId: accountId,
      metadata: { email, clientName },
      scope: approved.request.scope,
      props: { accountId, email },
    }));
  } catch {
    return page("failed", 500);
  }
  // The new grant may not be listed by KV for a while: keep the abandoned-sign-in check off it.
  try {
    await vaultFor(env, accountId).confirmGrant();
  } catch {
    // The grant stands; at worst the 10-minute check wipes the connection and the tool reconnects.
  }
  await writeAudit(env.DB, {
    event: "approval_allowed",
    outcome: "ok",
    accountId,
    email,
    clientId: approved.request.clientId,
    clientName,
  });
  return redirect(approved.headers, redirectTo);
}
