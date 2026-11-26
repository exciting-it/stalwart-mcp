/**
 * Drives the whole browser sign-in through `worker.fetch`, as an AI tool and a browser would:
 * register a client, `/authorize`, the fake Stalwart's sign-in, `/callback`, `/approve`, `/token`.
 * Each flow sends its own `cf-connecting-ip`, so the rate limits never couple two tests.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import worker from "../src/index";
import type { FakeStalwart } from "./fake-stalwart";

export const ORIGIN = "https://mail-mcp.test.example";
export const TOOL_REDIRECT = "https://tool.example/oauth/callback";

let ipCounter = 0;

/** A fresh client address per call (10.x.y.z). */
export function nextIp(): string {
  const n = ++ipCounter;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/** The cookies of one browser: name → value, honouring deletion by `Max-Age=0`. */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const removed = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || value === "";
      if (removed) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** A second browser holding the same cookies (to replay a request the first one already made). */
  copy(): CookieJar {
    const other = new CookieJar();
    for (const [k, v] of this.#cookies) other.#cookies.set(k, v);
    return other;
  }

  names(): string[] {
    return [...this.#cookies.keys()];
  }
}

/** One request through the Worker entry point. A jar, when given, sends and receives cookies. */
export async function send(
  url: string,
  init: RequestInit & { jar?: CookieJar; ip?: string } = {},
): Promise<Response> {
  const { jar, ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("cf-connecting-ip", ip ?? nextIp());
  if (jar && jar.header() !== "") headers.set("cookie", jar.header());
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(new URL(url, ORIGIN), { ...rest, headers, redirect: "manual" }), env, ctx);
  await waitOnExecutionContext(ctx);
  jar?.store(res);
  return res;
}

/** Form fields as an object, or as name/value pairs when a name repeats. */
export type FormFields = Record<string, string> | [string, string][];

export const postForm = (url: string, fields: FormFields, init: { jar?: CookieJar; ip?: string } = {}) =>
  send(url, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export async function registerClient(clientName: string, ip: string): Promise<string> {
  const res = await send("/register", {
    ip,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [TOOL_REDIRECT],
      client_name: clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`register failed: ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export function authorizeUrl(clientId: string, challenge: string, redirectUri = TOOL_REDIRECT): string {
  const url = new URL("/authorize", ORIGIN);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "mail",
    state: "tool-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export interface Flow {
  jar: CookieJar;
  ip: string;
  clientId: string;
  verifier: string;
  responses: Response[];
  /** Where the intro page of `/authorize` links to (Stalwart's sign-in). */
  stalwartUrl: string;
}

/**
 * Registers a client (or reuses `clientId`, the same tool connecting again) and runs `/authorize`;
 * the browser now stands at our intro page, one click from Stalwart's sign-in.
 */
export async function beginFlow(opts: { clientName?: string; clientId?: string } = {}): Promise<Flow> {
  const ip = nextIp();
  const jar = new CookieJar();
  const clientId = opts.clientId ?? (await registerClient(opts.clientName ?? "Test Tool", ip));
  const { verifier, challenge } = await pkce();
  const res = await send(authorizeUrl(clientId, challenge), { jar, ip });
  if (res.status !== 200) throw new Error(`authorize answered ${res.status}`);
  // The intro page: the user continues with its one link, as a browser would.
  const href = /<a class="go" href="([^"]+)"/.exec(await res.clone().text())?.[1];
  if (href === undefined) throw new Error("the intro page has no link to the sign-in");
  return { jar, ip, clientId, verifier, responses: [res], stalwartUrl: href.replaceAll("&amp;", "&") };
}

const unescapeHtml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/**
 * What a browser posts from the approval page's form, without the decision button: every hidden
 * field and every ticked checkbox, except the tools named in `untick` (by the name shown).
 */
export function approvalFields(html: string, untick: readonly string[] = []): [string, string][] {
  const form = /<form method="post" action="\/approve">([\s\S]*?)<\/form>/.exec(html)?.[1];
  if (form === undefined) throw new Error("the approval page has no form");
  const fields: [string, string][] = [];
  for (const m of form.matchAll(/<input type="(hidden|checkbox)"(?: id="([^"]+)")? name="([^"]+)" value="([^"]*)"( checked)?>/g)) {
    const [, type, id, name, value, checked] = m;
    if (type === "checkbox") {
      if (checked === undefined) continue;
      const label = new RegExp(`<label for="${id}"><span class="name">([^<]*)</span>`).exec(form)?.[1];
      if (label !== undefined && untick.includes(unescapeHtml(label))) continue;
    }
    fields.push([name!, unescapeHtml(value!)]);
  }
  return fields;
}

export async function connect(
  fake: FakeStalwart,
  email: string,
  opts: { decision?: "allow" | "deny"; clientName?: string; clientId?: string; untick?: readonly string[] } = {},
): Promise<{ accessToken?: string; refreshToken?: string; clientId: string; responses: Response[] }> {
  const flow = await beginFlow({ clientName: opts.clientName, clientId: opts.clientId });
  const { jar, ip, clientId, responses } = flow;
  const done = () => ({ clientId, responses });

  const callback = await send(fake.authorize(flow.stalwartUrl, email), { jar, ip });
  responses.push(callback);
  const approveAt = callback.headers.get("location");
  if (callback.status !== 302 || !approveAt?.startsWith(`${ORIGIN}/approve?`)) return done();

  const page = await send(approveAt, { jar, ip });
  responses.push(page);
  if (page.status !== 200) return done();

  // As a browser does: the page's own form, with the tools in `untick` unticked.
  const fields = approvalFields(await page.clone().text(), opts.untick);
  const decided = await postForm("/approve", [...fields, ["decision", opts.decision ?? "allow"]], { jar, ip });
  responses.push(decided);
  const back = decided.headers.get("location");
  const code = back ? new URL(back).searchParams.get("code") : null;
  if (decided.status !== 302 || !code) return done();

  const token = await postForm(
    "/token",
    { grant_type: "authorization_code", code, redirect_uri: TOOL_REDIRECT, client_id: clientId, code_verifier: flow.verifier },
    { ip },
  );
  responses.push(token);
  if (token.status !== 200) return done();
  const body = (await token.clone().json()) as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token, clientId, responses };
}

let rpcId = 0;

/** A JSON-RPC `tools/call` on `/mcp` with the Worker's access token. */
export async function callTool(accessToken: string, name: string, args: unknown): Promise<CallToolResult> {
  const res = await send("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.status !== 200) throw new Error(`/mcp answered ${res.status}`);
  const body = (await res.json()) as { result?: CallToolResult; error?: unknown };
  if (!body.result) throw new Error("/mcp answered a JSON-RPC error");
  return body.result;
}
