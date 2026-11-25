/**
 * The only code that talks HTTP to Stalwart's JMAP endpoints (RFC 8620). Every failure leaves
 * as an `UpstreamAuthError` or a `MailError` with a fixed message; upstream text never does.
 */
import { MailError, type MailErrorCode, MailIdSchema } from "../mail";
import { STALWART } from "../stalwart/endpoints";
import { readJsonBody, stalwartFetch } from "../stalwart/http";

export type JmapInvocation = [name: string, args: Record<string, unknown>, callId: string];

/** HTTP 401 from Stalwart: the access token is no longer accepted. */
export class UpstreamAuthError extends Error {
  constructor() {
    super("The mail server did not accept the access token.");
    this.name = "UpstreamAuthError";
  }
}

export interface JmapSession {
  apiUrl: string;
  accountId: string;
  username: string;
}

const USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
] as const;
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function onStalwart(url: string): boolean {
  try {
    return new URL(url).origin === STALWART.origin;
  } catch {
    return false;
  }
}

/**
 * Fetches with the token, never following a redirect, and reads the JSON answer. With
 * `outcomeUnknown`, every failure after which the server may have processed the request (network
 * error, timeout, 5xx, an unreadable 200) is that code instead; a 401 and other 4xx stay as they
 * are, because the server refused the request without processing it.
 */
async function requestJson(
  url: string,
  accessToken: string,
  init: RequestInit,
  outcomeUnknown?: MailErrorCode,
): Promise<unknown> {
  const unknownOr = (e: unknown): unknown => (outcomeUnknown ? new MailError(outcomeUnknown) : e);
  let res: Response;
  try {
    res = await stalwartFetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    throw unknownOr(e);
  }
  if (res.status === 401) {
    await res.body?.cancel();
    throw new UpstreamAuthError();
  }
  if (res.status >= 500) {
    await res.body?.cancel();
    throw unknownOr(new MailError("upstream_unavailable"));
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new MailError("upstream_rejected");
  }
  try {
    return await readJsonBody(res);
  } catch (e) {
    throw unknownOr(e);
  }
}

export async function fetchSession(accessToken: string): Promise<JmapSession> {
  const body = await requestJson(STALWART.session, accessToken, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!isObject(body) || !isObject(body.primaryAccounts)) throw new MailError("upstream_rejected");
  const { apiUrl, username } = body;
  const accountId = body.primaryAccounts[MAIL_CAPABILITY];
  if (typeof apiUrl !== "string" || !onStalwart(apiUrl)) throw new MailError("upstream_rejected");
  if (typeof username !== "string" || username === "") throw new MailError("upstream_rejected");
  if (!MailIdSchema.safeParse(accountId).success) throw new MailError("upstream_rejected");
  return { apiUrl, accountId: accountId as string, username };
}

function isInvocation(v: unknown): v is JmapInvocation {
  return Array.isArray(v) && v.length === 3 && typeof v[0] === "string" && isObject(v[1]) && typeof v[2] === "string";
}

/**
 * One JMAP request. `outcomeUnknown` is for a request that must never be repeated blindly (the
 * submission): any answer that does not show what the server did leaves as that code.
 */
export async function jmapCall(
  session: JmapSession,
  accessToken: string,
  calls: JmapInvocation[],
  { outcomeUnknown }: { outcomeUnknown?: MailErrorCode } = {},
): Promise<JmapInvocation[]> {
  // Checked again here, so a stored or hand-made session can never carry the token elsewhere.
  if (!onStalwart(session.apiUrl)) throw new MailError("upstream_rejected");
  const body = await requestJson(
    session.apiUrl,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ using: USING, methodCalls: calls }),
    },
    outcomeUnknown,
  );
  if (!isObject(body) || !Array.isArray(body.methodResponses) || !body.methodResponses.every(isInvocation)) {
    throw new MailError(outcomeUnknown ?? "upstream_rejected");
  }
  return body.methodResponses;
}

/**
 * The arguments of the answer to `callId`. A method error `notFound` (or `invalidArguments`
 * when the call's ids came from tool input) is `not_found`; any other error or a missing
 * answer is `upstream_rejected`. The upstream description is never passed on.
 */
export function methodResult(
  responses: JmapInvocation[],
  callId: string,
  name: string,
  { idsFromInput = false }: { idsFromInput?: boolean } = {},
): Record<string, unknown> {
  const answer = responses.find((r) => r[2] === callId && (r[0] === name || r[0] === "error"));
  if (!answer) throw new MailError("upstream_rejected");
  if (answer[0] === "error") {
    const type = answer[1].type;
    if (type === "notFound" || (idsFromInput && type === "invalidArguments")) throw new MailError("not_found");
    throw new MailError("upstream_rejected");
  }
  return answer[1];
}
