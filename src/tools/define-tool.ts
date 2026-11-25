/**
 * The one wrapper every tool goes through: validate → authorize → act → audit. The account
 * comes only from the grant; a result leaves only as the parsed output schema; a failure leaves
 * only as the fixed sentence of its error code.
 */
import type { Area } from "../config";
import { COLLAB_CONTENT_NOTICE, type Mailbox } from "../collab";
import {
  MAIL_ERROR_MESSAGES,
  MailError,
  UNTRUSTED_CONTENT_NOTICE,
  type MailErrorCode,
  type SearchMailResult,
} from "../mail";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AuditEntry } from "../audit";

export interface Grant {
  accountId: string;
  email: string;
  clientId: string;
}

export interface ToolDeps {
  enabled(): boolean;
  blocked(g: Grant): Promise<boolean>;
  mailbox(g: Grant): Mailbox;
  audit(e: AuditEntry): Promise<void>;
  /**
   * Revokes the Worker grant `accessToken` belongs to. The MCP handler calls it when the mailbox
   * answers `reconnect_required`, so the AI tool's next request is a 401 and it signs in anew.
   */
  endGrant(accessToken: string): Promise<void>;
}

export interface ToolSpec<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  kind: "read" | "draft" | "send" | "move" | "trash" | "create" | "update" | "destroy";
  /** The area this tool belongs to; without one it is a mail tool and always offered. */
  area?: Area;
  input: I;
  output: O;
  /** `grant` is the verified connection: its address may be shown, never chosen by the input. */
  run(mailbox: Mailbox, input: z.infer<I>, grant: Grant): Promise<z.infer<O>>;
  count?(result: z.infer<O>): number;
}

export interface Tool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous list of specs
  spec: ToolSpec<any, any>;
  execute(deps: ToolDeps, grant: Grant, rawInput: unknown): Promise<CallToolResult>;
}

/** Codes that mean "not allowed or not now" rather than "something broke". */
const REFUSED_CODES: ReadonlySet<MailErrorCode> = new Set<MailErrorCode>([
  "invalid_input",
  "disabled",
  "blocked",
  "rate_limited",
  "send_limit_reached",
  "recipient_not_allowed",
  "reconnect_required",
  "not_granted",
]);

type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; code: MailErrorCode };

interface Recipients {
  to: unknown[];
  cc: unknown[];
  bcc: unknown[];
}

type ContentNotice = z.infer<typeof SearchMailResult>["content_notice"];

/** Marks a result that carries mail content (`search_mail`, `read_thread`) with the fixed notice. */
export function withContentNotice<T extends object>(result: T): { content_notice: ContentNotice } & T {
  // Core declares the notice as `string`; the result schema's literal is checked again in `execute`.
  return { content_notice: UNTRUSTED_CONTENT_NOTICE as ContentNotice, ...result };
}

/** Marks a result that carries contacts or calendar content with its fixed notice. */
export function withCollabNotice<T extends object>(result: T): { content_notice: typeof COLLAB_CONTENT_NOTICE } & T {
  return { content_notice: COLLAB_CONTENT_NOTICE, ...result };
}

/** The untrusted-content notice leads the result, so a reader meets it before any mail text. */
function noticeFirst(result: Record<string, unknown>): Record<string, unknown> {
  return "content_notice" in result ? { content_notice: result.content_notice, ...result } : result;
}

export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(spec: ToolSpec<I, O>): Tool {
  async function attempt(deps: ToolDeps, grant: Grant, input: z.SafeParseReturnType<unknown, z.infer<I>>): Promise<Outcome> {
    try {
      if (!input.success) throw new MailError("invalid_input");
      if (!deps.enabled()) throw new MailError("disabled");
      if (await deps.blocked(grant)) throw new MailError("blocked");
      const output = spec.output.safeParse(await spec.run(deps.mailbox(grant), input.data, grant));
      if (!output.success) throw new MailError("internal");
      return { ok: true, result: noticeFirst(output.data as Record<string, unknown>) };
    } catch (error) {
      return { ok: false, code: error instanceof MailError ? error.code : "internal" };
    }
  }

  function auditEntry(grant: Grant, input: z.SafeParseReturnType<unknown, z.infer<I>>, outcome: Outcome): AuditEntry {
    const entry: AuditEntry = {
      event: "tool_call",
      tool: spec.name,
      outcome: outcome.ok ? "ok" : REFUSED_CODES.has(outcome.code) ? "refused" : "error",
      accountId: grant.accountId,
      email: grant.email,
      clientId: grant.clientId,
    };
    if (!outcome.ok) entry.errorCode = outcome.code;
    if (spec.kind === "send" && input.success) {
      const m = input.data as Recipients;
      entry.recipientCount = m.to.length + m.cc.length + m.bcc.length;
    }
    if (outcome.ok) {
      if (spec.count) entry.resultCount = spec.count(outcome.result as z.infer<O>);
      if (spec.kind === "send") entry.messageId = String(outcome.result.message_id);
      if (spec.kind === "draft") entry.messageId = String(outcome.result.draft_id);
    }
    return entry;
  }

  return {
    spec,
    async execute(deps, grant, rawInput) {
      const input = spec.input.safeParse(rawInput) as z.SafeParseReturnType<unknown, z.infer<I>>;
      const outcome = await attempt(deps, grant, input);
      try {
        await deps.audit(auditEntry(grant, input, outcome));
      } catch {
        // The action already happened (a sent mail stays sent); its result stands.
      }
      if (!outcome.ok) {
        return { isError: true, content: [{ type: "text", text: MAIL_ERROR_MESSAGES[outcome.code] }] };
      }
      return { structuredContent: outcome.result, content: [{ type: "text", text: JSON.stringify(outcome.result) }] };
    },
  };
}
