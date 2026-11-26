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
  /**
   * The download URL template (RFC 8620 §6.2) when it is on Stalwart's origin and names
   * `{accountId}` and `{blobId}`; null otherwise, and then nothing can be downloaded.
   */
  downloadUrl: string | null;
  accountId: string;
  username: string;
  /**
   * The capabilities for which this account is the token's primary account. Stalwart lists only
   * what the token's scopes allow, so this tells whether a connection may use contacts or calendars.
   */
  capabilities: string[];
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

/** A download template the worker may use: on Stalwart's origin, naming the account and the blob. */
export function usableDownloadUrl(template: unknown): string | null {
  if (typeof template !== "string" || !onStalwart(template)) return null;
  return template.includes("{accountId}") && template.includes("{blobId}") ? template : null;
}

/**
 * Fetches with the token, never following a redirect, and answers the 200 response. A 401 is
 * `UpstreamAuthError`, a 5xx `upstream_unavailable`, any other status `upstream_rejected`; the
 * body of a refusal is never read. With `outcomeUnknown`, every failure after which the server
 * may have processed the request (network error, timeout, 5xx) is that code instead; a 401 and
 * other 4xx stay as they are, because the server refused the request without processing it.
 */
async function requestOk(url: string, accessToken: string, init: RequestInit, outcomeUnknown?: MailErrorCode): Promise<Response> {
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
  return res;
}

/** `requestOk`, then the JSON answer; with `outcomeUnknown` an unreadable 200 is that code too. */
async function requestJson(
  url: string,
  accessToken: string,
  init: RequestInit,
  outcomeUnknown?: MailErrorCode,
): Promise<unknown> {
  const res = await requestOk(url, accessToken, init, outcomeUnknown);
  try {
    return await readJsonBody(res);
  } catch (e) {
    throw outcomeUnknown ? new MailError(outcomeUnknown) : e;
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
  const capabilities = Object.entries(body.primaryAccounts)
    .filter(([, id]) => id === accountId)
    .map(([capability]) => capability);
  return { apiUrl, downloadUrl: usableDownloadUrl(body.downloadUrl), accountId: accountId as string, username, capabilities };
}

/**
 * Downloads one blob of `accountId` through the session's template (RFC 8620 §6.2), with a fixed
 * name and type: nothing of the attachment's own metadata is put into the URL. More than
 * `maxBytes` is `too_large`, decided while reading, whatever the answer's `Content-Length` says;
 * the rest of such a body is not read. A session without a usable template is `mailbox_unsupported`.
 */
export async function downloadBlob(
  session: JmapSession,
  accessToken: string,
  accountId: string,
  blobId: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const template = usableDownloadUrl(session.downloadUrl);
  if (template === null) throw new MailError("mailbox_unsupported");
  const values: Record<string, string> = { accountId, blobId, name: "attachment", type: "application/octet-stream" };
  const url = template.replace(/\{(accountId|blobId|name|type)\}/g, (_, key: string) => encodeURIComponent(values[key]!));
  // Checked again on the filled URL, so no value can carry the token elsewhere.
  if (!onStalwart(url)) throw new MailError("mailbox_unsupported");
  const res = await requestOk(url, accessToken, { method: "GET" });
  return readCapped(res, maxBytes);
}

/** The body, at most `maxBytes` of it; one byte more stops the reading and is `too_large`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MailError("too_large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof MailError) throw e;
    throw new MailError("upstream_unavailable");
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
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
  { outcomeUnknown, using = USING }: { outcomeUnknown?: MailErrorCode; using?: readonly string[] } = {},
): Promise<JmapInvocation[]> {
  // Checked again here, so a stored or hand-made session can never carry the token elsewhere.
  if (!onStalwart(session.apiUrl)) throw new MailError("upstream_rejected");
  const body = await requestJson(
    session.apiUrl,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ using, methodCalls: calls }),
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
