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

export const postForm = (url: string, fields: Record<string, string>, init: { jar?: CookieJar; ip?: string } = {}) =>
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
  /** Where `/authorize` sent the browser (Stalwart's sign-in). */
  stalwartUrl: string;
}

/** Registers a client and runs `/authorize`; the browser now stands at Stalwart's sign-in. */
export async function beginFlow(opts: { clientName?: string } = {}): Promise<Flow> {
  const ip = nextIp();
  const jar = new CookieJar();
  const clientId = await registerClient(opts.clientName ?? "Test Tool", ip);
  const { verifier, challenge } = await pkce();
  const res = await send(authorizeUrl(clientId, challenge), { jar, ip });
  if (res.status !== 302) throw new Error(`authorize answered ${res.status}`);
  return { jar, ip, clientId, verifier, responses: [res], stalwartUrl: res.headers.get("location")! };
}

export async function connect(
  fake: FakeStalwart,
  email: string,
  opts: { decision?: "allow" | "deny"; clientName?: string } = {},
): Promise<{ accessToken?: string; refreshToken?: string; clientId: string; responses: Response[] }> {
  const flow = await beginFlow({ clientName: opts.clientName });
  const { jar, ip, clientId, responses } = flow;
  const done = () => ({ clientId, responses });

  const callback = await send(fake.authorize(flow.stalwartUrl, email), { jar, ip });
  responses.push(callback);
  const approveAt = callback.headers.get("location");
  if (callback.status !== 302 || !approveAt?.startsWith(`${ORIGIN}/approve?`)) return done();

  const page = await send(approveAt, { jar, ip });
  responses.push(page);
  if (page.status !== 200) return done();

  const handle = new URL(approveAt).searchParams.get("h")!;
  const decided = await postForm("/approve", { h: handle, decision: opts.decision ?? "allow" }, { jar, ip });
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
