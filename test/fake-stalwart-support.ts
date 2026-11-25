/**
 * What the JMAP method handlers of the fake Stalwart share: the method error, the handler
 * context and small argument helpers. A leaf module (types from `fake-stalwart-state.ts` only),
 * so `fake-stalwart-jmap.ts` (mail, dispatcher) and `fake-stalwart-collab.ts` (contacts,
 * calendars) can both import it without importing each other.
 */
import type { JmapInvocation } from "../src/jmap/jmap-client";
import type { FakeAccount, FakeState } from "./fake-stalwart-state";

export type Args = Record<string, unknown>;

/** A method-level error: answered as `["error", { type }, callId]`, the request goes on. */
export class MethodError extends Error {
  constructor(readonly type: string) {
    super(type);
  }
}

export interface Ctx {
  state: FakeState;
  account: FakeAccount;
  callId: string;
  out: JmapInvocation[];
  /** Creation id → server id, for every object created earlier in this request. */
  createdIds: Map<string, string>;
}

export type Handler = (args: Args, ctx: Ctx) => void;

/** The areas beyond mail; a token carries one scope for each it was asked for. */
export type FakeArea = "contacts" | "calendars";

export interface MethodEntry {
  capability: string;
  /** Served only when the request's token has the scope of this area. */
  area?: FakeArea;
  handler: Handler;
}

export const isObject = (v: unknown): v is Args => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `ids` argument of a `/get`: null for "all", else a list of strings. */
export function ids(args: Args): string[] | null {
  if (args.ids === null || args.ids === undefined) return null;
  if (!Array.isArray(args.ids) || !args.ids.every((i) => typeof i === "string")) {
    throw new MethodError("invalidArguments");
  }
  return args.ids as string[];
}

/** `obj` restricted to `properties` (always with `id`); an unknown property is `invalidArguments`. */
export function pick(obj: Args, properties: unknown, known: readonly string[]): Args {
  if (properties === null || properties === undefined) return obj;
  if (!Array.isArray(properties)) throw new MethodError("invalidArguments");
  const out: Args = { id: obj.id };
  for (const p of properties) {
    if (typeof p !== "string" || !known.includes(p)) throw new MethodError("invalidArguments");
    out[p] = obj[p];
  }
  return out;
}

/** Case-insensitive substring test. */
export const contains = (haystack: string | null | undefined, needle: string): boolean =>
  (haystack ?? "").toLowerCase().includes(needle.toLowerCase());

/** `position` and `limit` of a `/query` applied to `found` (RFC 8620 §5.5). */
export function page<T>(args: Args, found: T[]): { start: number; items: T[] } {
  const position = typeof args.position === "number" ? args.position : 0;
  if (!Number.isInteger(position)) throw new MethodError("invalidArguments");
  const start = position < 0 ? Math.max(0, found.length + position) : position;
  const limit = typeof args.limit === "number" ? args.limit : found.length;
  if (!Number.isInteger(limit) || limit < 0) throw new MethodError("invalidArguments");
  return { start, items: found.slice(start, start + limit) };
}
