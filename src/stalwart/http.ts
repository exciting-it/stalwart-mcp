/** Transport plumbing shared by every call to Stalwart. Upstream text never leaves in an error. */
import { MailError } from "../mail";

const TIMEOUT_MS = 10_000;

/** Calls the global `fetch`, never following a redirect. Network errors and timeouts are `upstream_unavailable`. */
export async function stalwartFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new MailError("upstream_unavailable");
  }
}

/** Reads the body as JSON: a read failure is `upstream_unavailable`, unparseable JSON is `upstream_rejected`. */
export async function readJsonBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new MailError("upstream_unavailable");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MailError("upstream_rejected");
  }
}
