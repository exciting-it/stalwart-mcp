/**
 * Contacts handlers of the fake Stalwart (RFC 9610: `AddressBook/get`, `ContactCard/query`,
 * `ContactCard/get`), and the table `fake-stalwart-jmap.ts` merges into its method table.
 * and the calendar ones (draft-ietf-jmap-calendars: `Calendar/get`, `CalendarEvent/query`,
 * `CalendarEvent/get`, with `expandRecurrences` for daily and weekly rules and `utcStart` / `utcEnd`).
 *
 * and the write side, one shared `/set` engine (`applySet`: `create`, `update` as a PatchObject of
 * top-level properties, `destroy`) with a spec per type; `ContactCard/set` is the first user.
 *
 * Everything is scoped to the request's account: another account's ids are `notFound`.
 */
import type { FakeAccount, FakeContact, FakeEvent } from "./fake-stalwart-state";
import {
  type Args,
  contains,
  type Ctx,
  type Handler,
  ids,
  isObject,
  type MethodEntry,
  MethodError,
  page,
  pick,
} from "./fake-stalwart-support";

export const COLLAB_CAPABILITIES = {
  contacts: "urn:ietf:params:jmap:contacts",
  calendars: "urn:ietf:params:jmap:calendars",
} as const;

/** The OAuth scope that carries each area. */
export const AREA_SCOPES = {
  contacts: "urn:ietf:params:oauth:scope:contacts",
  calendars: "urn:ietf:params:oauth:scope:calendars",
} as const;

const CONTACTS = COLLAB_CAPABILITIES.contacts;
const CALENDARS = COLLAB_CAPABILITIES.calendars;

const values = (v: unknown): Args[] => (isObject(v) ? Object.values(v).filter(isObject) : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

const idOrder = (a: string, b: string): number => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""));

// ---- AddressBook/get ----

const ADDRESS_BOOK_PROPS = ["id", "name", "description", "sortOrder", "isDefault", "isSubscribed", "myRights"] as const;

const addressBookGet: Handler = (args, { account, callId, out }) => {
  const wanted = ids(args);
  const list: Args[] = [];
  const notFound: string[] = [];
  for (const id of wanted ?? [...account.addressBooks.keys()]) {
    const book = account.addressBooks.get(id);
    if (!book) {
      notFound.push(id);
      continue;
    }
    const full: Args = {
      id: book.id,
      name: book.name,
      description: null,
      sortOrder: 0,
      isDefault: book.isDefault,
      isSubscribed: true,
      myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
    };
    list.push(pick(full, args.properties, ADDRESS_BOOK_PROPS));
  }
  out.push(["AddressBook/get", { accountId: account.accountId, state: "ab-state", list, notFound }, callId]);
};

// ---- ContactCard/query ----

const CONTACT_FILTER_KEYS = new Set(["text", "name", "email", "phone", "organization", "inAddressBook"]);

function nameTexts(c: FakeContact): string[] {
  const name = isObject(c.name) ? c.name : {};
  const components = Array.isArray(name.components) ? name.components.filter(isObject) : [];
  return [text(name.full), ...components.map((p) => text(p.value))];
}
const emailTexts = (c: FakeContact) => values(c.emails).map((e) => text(e.address));
const phoneTexts = (c: FakeContact) => values(c.phones).map((p) => text(p.number));
function organizationTexts(c: FakeContact): string[] {
  return values(c.organizations).flatMap((o) => [
    text(o.name),
    ...(Array.isArray(o.units) ? o.units.filter(isObject).map((u) => text(u.name)) : []),
  ]);
}
const anyContains = (list: string[], needle: string) => list.some((t) => contains(t, needle));

/** Like the server, rejects an unknown filter key up front, even when there is nothing to match. */
function validateFilter(filter: unknown): void {
  if (filter === null || filter === undefined) return;
  if (!isObject(filter)) throw new MethodError("invalidArguments");
  if ("operator" in filter) {
    if (!Array.isArray(filter.conditions)) throw new MethodError("invalidArguments");
    for (const condition of filter.conditions) validateFilter(condition);
    return;
  }
  for (const key of Object.keys(filter)) if (!CONTACT_FILTER_KEYS.has(key)) throw new MethodError("unsupportedFilter");
}

function matches(c: FakeContact, filter: unknown): boolean {
  if (filter === null || filter === undefined) return true;
  if (!isObject(filter)) throw new MethodError("invalidArguments");
  if ("operator" in filter) {
    const conditions = filter.conditions;
    if (!Array.isArray(conditions)) throw new MethodError("invalidArguments");
    const results = conditions.map((cond) => matches(c, cond));
    if (filter.operator === "AND") return results.every(Boolean);
    if (filter.operator === "OR") return results.some(Boolean);
    if (filter.operator === "NOT") return !results.some(Boolean);
    throw new MethodError("unsupportedFilter");
  }
  for (const [k, v] of Object.entries(filter)) {
    if (!CONTACT_FILTER_KEYS.has(k)) throw new MethodError("unsupportedFilter");
    if (typeof v !== "string") throw new MethodError("invalidArguments");
    const ok =
      k === "inAddressBook" ? c.addressBookIds[v] === true
      : k === "name" ? anyContains(nameTexts(c), v)
      : k === "email" ? anyContains(emailTexts(c), v)
      : k === "phone" ? anyContains(phoneTexts(c), v)
      : k === "organization" ? anyContains(organizationTexts(c), v)
      : anyContains(
          [
            ...nameTexts(c),
            ...emailTexts(c),
            ...phoneTexts(c),
            ...organizationTexts(c),
            ...values(c.nicknames).map((n) => text(n.name)),
            ...values(c.titles).map((t) => text(t.name)),
            ...values(c.notes).map((n) => text(n.note)),
          ],
          v,
        );
    if (!ok) return false;
  }
  return true;
}

const contactQuery: Handler = (args, { account, callId, out }) => {
  // An address book that is not this account's is an error here, not an empty result: the adapter
  // must have looked the id up itself before it answers an empty page.
  const book = isObject(args.filter) ? args.filter.inAddressBook : undefined;
  if (typeof book === "string" && !account.addressBooks.has(book)) throw new MethodError("invalidArguments");
  const sort = args.sort ?? [];
  if (!Array.isArray(sort)) throw new MethodError("invalidArguments");
  let ascending = true;
  for (const s of sort) {
    if (!isObject(s) || s.property !== "updated") throw new MethodError("unsupportedSort");
    ascending = s.isAscending !== false;
  }
  validateFilter(args.filter);
  const found = [...account.contacts.values()]
    .filter((c) => matches(c, args.filter))
    .sort((a, b) => (a.updated.localeCompare(b.updated) || idOrder(a.id, b.id)) * (ascending ? 1 : -1));
  const { start, items } = page(args, found);
  const result: Args = {
    accountId: account.accountId,
    queryState: "cq-state",
    canCalculateChanges: false,
    position: start,
    ids: items.map((c) => c.id),
  };
  if (args.calculateTotal === true) result.total = found.length;
  out.push(["ContactCard/query", result, callId]);
};

// ---- ContactCard/get ----

const CONTACT_PROPS = [
  "id", "addressBookIds", "uid", "kind", "name", "nicknames", "emails", "phones", "organizations",
  "titles", "addresses", "notes", "anniversaries", "updated", "created",
] as const;

const contactGet: Handler = (args, { account, callId, out }) => {
  const wanted = ids(args);
  const list: Args[] = [];
  const notFound: string[] = [];
  for (const id of wanted ?? [...account.contacts.keys()]) {
    const card = account.contacts.get(id);
    if (!card) {
      notFound.push(id);
      continue;
    }
    list.push(structuredClone(pick(card, args.properties, CONTACT_PROPS)));
  }
  out.push(["ContactCard/get", { accountId: account.accountId, state: "cc-state", list, notFound }, callId]);
};

// ---- Calendar/get ----

const CALENDAR_PROPS = [
  "id", "name", "description", "color", "sortOrder", "isSubscribed", "isVisible", "isDefault", "timeZone", "myRights",
] as const;

const calendarGet: Handler = (args, { account, callId, out }) => {
  const wanted = ids(args);
  const list: Args[] = [];
  const notFound: string[] = [];
  for (const id of wanted ?? [...account.calendars.keys()]) {
    const calendar = account.calendars.get(id);
    if (!calendar) {
      notFound.push(id);
      continue;
    }
    const full: Args = {
      id: calendar.id,
      name: calendar.name,
      description: calendar.description,
      color: calendar.color,
      sortOrder: 0,
      isSubscribed: true,
      isVisible: true,
      isDefault: calendar.isDefault,
      timeZone: calendar.timeZone,
      myRights: {
        mayReadFreeBusy: true,
        mayReadItems: true,
        mayWriteAll: calendar.mayWrite,
        mayWriteOwn: calendar.mayWrite,
        mayRSVP: true,
        mayDelete: calendar.mayWrite,
      },
    };
    list.push(pick(full, args.properties, CALENDAR_PROPS));
  }
  out.push(["Calendar/get", { accountId: account.accountId, state: "cal-state", list, notFound }, callId]);
};

// ---- time: LocalDateTime, zones, durations ----

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const DAY = 86_400_000;

/** A LocalDateTime read as if it were UTC (milliseconds); anything else is `invalidArguments`. */
function localMs(local: unknown): number {
  const m = typeof local === "string" ? LOCAL.exec(local) : null;
  if (!m) throw new MethodError("invalidArguments");
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}
const formatLocal = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const formatUtc = (ms: number): string => `${formatLocal(ms)}Z`;

/** Offset of `zone` from UTC at the instant `utcMs`, in milliseconds. */
function zoneOffsetMs(zone: string, utcMs: number): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
  } catch {
    throw new MethodError("invalidArguments");
  }
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - utcMs;
}

/** The instant (UTC milliseconds) of a LocalDateTime in `zone` (null: UTC). Zones come from `Intl`. */
function localToUtc(local: unknown, zone: string | null): number {
  const t = localMs(local);
  const z = zone ?? "Etc/UTC";
  const first = zoneOffsetMs(z, t);
  const second = zoneOffsetMs(z, t - first);
  return t - (second === first ? first : second);
}

function durationMs(duration: unknown): number {
  const m = typeof duration === "string" ? /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration) : null;
  if (!m) throw new MethodError("invalidArguments");
  const [w, d, h, min, sec] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number];
  return (w * 7 + d) * DAY + ((h * 60 + min) * 60 + sec) * 1000;
}

const zoneOf = (e: FakeEvent): string | null => (typeof e.timeZone === "string" ? e.timeZone : null);

// ---- recurrence: daily and weekly rules with interval, count and until ----

interface Occurrence {
  id: string;
  /** LocalDateTime of this occurrence, in the event's zone. */
  start: string;
}

const compact = (local: string): string => local.replace(/[-:]/g, "");

function recurrenceRule(e: FakeEvent): Args | null {
  const rule = Array.isArray(e.recurrenceRules) ? e.recurrenceRules.find(isObject) : undefined;
  return rule ?? null;
}

/**
 * The occurrences of `e` that start before the instant `beforeUtc`. A recurring event gets a
 * synthetic id for each, `<event id>-<YYYYMMDDTHHMMSS>`; a single event keeps its own id.
 */
function occurrences(e: FakeEvent, beforeUtc: number): Occurrence[] {
  const rule = recurrenceRule(e);
  if (rule === null) return localToUtc(e.start, zoneOf(e)) < beforeUtc ? [{ id: e.id, start: e.start }] : [];
  if (rule.frequency !== "daily" && rule.frequency !== "weekly") {
    throw new Error(`fake-stalwart: recurrence frequency ${String(rule.frequency)} is not supported`);
  }
  const stepDays = (rule.frequency === "weekly" ? 7 : 1) * (typeof rule.interval === "number" ? rule.interval : 1);
  const count = typeof rule.count === "number" ? rule.count : Infinity;
  const until = typeof rule.until === "string" ? localMs(rule.until.slice(0, 19)) : Infinity;
  const first = localMs(e.start);
  const found: Occurrence[] = [];
  for (let k = 0; k < count && k < 5000; k++) {
    const local = first + k * stepDays * DAY;
    if (local > until) break;
    const start = formatLocal(local);
    if (localToUtc(start, zoneOf(e)) >= beforeUtc) break;
    found.push({ id: `${e.id}-${compact(start)}`, start });
  }
  return found;
}

/** The event as the server shows it for one occurrence: its own start, `recurrenceId`, no rules. */
function occurrenceView(e: FakeEvent, occurrence: Occurrence): FakeEvent {
  if (occurrence.id === e.id) return e;
  return { ...e, id: occurrence.id, start: occurrence.start, recurrenceId: occurrence.start, recurrenceRules: null, recurrenceOverrides: null };
}

// ---- CalendarEvent/query ----

const EVENT_FILTER_KEYS = new Set(["after", "before", "inCalendar", "text"]);

function validateEventFilter(filter: unknown): void {
  if (filter === null || filter === undefined) return;
  if (!isObject(filter)) throw new MethodError("invalidArguments");
  if ("operator" in filter) {
    if (!Array.isArray(filter.conditions)) throw new MethodError("invalidArguments");
    for (const condition of filter.conditions) validateEventFilter(condition);
    return;
  }
  for (const key of Object.keys(filter)) if (!EVENT_FILTER_KEYS.has(key)) throw new MethodError("unsupportedFilter");
}

function eventTexts(e: FakeEvent): string[] {
  return [
    text(e.title),
    text(e.description),
    ...values(e.locations).map((l) => text(l.name)),
    ...values(e.participants).flatMap((p) => [text(p.name), text(p.email)]),
  ];
}

function eventMatches(e: FakeEvent, start: string, zone: string, filter: unknown): boolean {
  if (filter === null || filter === undefined) return true;
  if (!isObject(filter)) throw new MethodError("invalidArguments");
  if ("operator" in filter) {
    const conditions = filter.conditions;
    if (!Array.isArray(conditions)) throw new MethodError("invalidArguments");
    const results = conditions.map((c) => eventMatches(e, start, zone, c));
    if (filter.operator === "AND") return results.every(Boolean);
    if (filter.operator === "OR") return results.some(Boolean);
    if (filter.operator === "NOT") return !results.some(Boolean);
    throw new MethodError("unsupportedFilter");
  }
  const begin = localToUtc(start, zoneOf(e));
  const end = begin + durationMs(e.duration);
  for (const [k, v] of Object.entries(filter)) {
    if (!EVENT_FILTER_KEYS.has(k)) throw new MethodError("unsupportedFilter");
    if (typeof v !== "string") throw new MethodError("invalidArguments");
    // An event overlaps the window when it ends after `after` and starts before `before`.
    const ok =
      k === "inCalendar" ? e.calendarIds[v] === true
      : k === "after" ? (end > begin ? end > localToUtc(v, zone) : begin >= localToUtc(v, zone))
      : k === "before" ? begin < localToUtc(v, zone)
      : eventTexts(e).some((t) => contains(t, v));
    if (!ok) return false;
  }
  return true;
}

/** With `expandRecurrences` the filter must be one condition holding both `after` and `before`. */
function expansionWindow(filter: unknown): { beforeLocal: string } {
  if (!isObject(filter) || "operator" in filter || typeof filter.after !== "string" || typeof filter.before !== "string") {
    throw new MethodError("invalidArguments");
  }
  return { beforeLocal: filter.before };
}

const calendarEventQuery: Handler = (args, { account, callId, out }) => {
  // The same for a calendar that is not this account's.
  const calendar = isObject(args.filter) ? args.filter.inCalendar : undefined;
  if (typeof calendar === "string" && !account.calendars.has(calendar)) throw new MethodError("invalidArguments");
  const sort = args.sort ?? [];
  if (!Array.isArray(sort)) throw new MethodError("invalidArguments");
  let ascending = true;
  for (const s of sort) {
    if (!isObject(s) || s.property !== "start") throw new MethodError("unsupportedSort");
    ascending = s.isAscending !== false;
  }
  if (args.timeZone !== undefined && typeof args.timeZone !== "string") throw new MethodError("invalidArguments");
  const zone = typeof args.timeZone === "string" ? args.timeZone : "Etc/UTC";
  validateEventFilter(args.filter);
  const expand = args.expandRecurrences === true;
  const beforeUtc = expand ? localToUtc(expansionWindow(args.filter).beforeLocal, zone) : Infinity;

  const hits: { id: string; utc: number }[] = [];
  for (const event of account.events.values()) {
    const candidates = expand ? occurrences(event, beforeUtc) : [{ id: event.id, start: event.start }];
    for (const occurrence of candidates) {
      if (eventMatches(event, occurrence.start, zone, args.filter)) {
        hits.push({ id: occurrence.id, utc: localToUtc(occurrence.start, zoneOf(event)) });
      }
    }
  }
  hits.sort((a, b) => (a.utc - b.utc || a.id.localeCompare(b.id)) * (ascending ? 1 : -1));
  const { start, items } = page(args, hits);
  const result: Args = {
    accountId: account.accountId,
    queryState: "ce-state",
    canCalculateChanges: false,
    position: start,
    ids: items.map((h) => h.id),
  };
  if (args.calculateTotal === true) result.total = hits.length;
  out.push(["CalendarEvent/query", result, callId]);
};

// ---- CalendarEvent/get ----

const EVENT_PROPS = [
  "id", "calendarIds", "uid", "title", "description", "descriptionContentType", "start", "timeZone", "duration",
  "showWithoutTime", "utcStart", "utcEnd", "status", "freeBusyStatus", "privacy", "recurrenceId", "recurrenceRules",
  "recurrenceOverrides", "locations", "virtualLocations", "participants", "created", "updated",
] as const;

/** The event or occurrence `id` names in this account, or null. */
function resolveEvent(account: FakeAccount, id: string): { event: FakeEvent; occurrence: Occurrence } | null {
  const own = account.events.get(id);
  if (own) return { event: own, occurrence: { id, start: own.start } };
  const m = /^(.+)-(\d{8})T(\d{6})$/.exec(id);
  const event = m ? account.events.get(m[1]!) : undefined;
  if (!m || !event || recurrenceRule(event) === null) return null;
  const start = `${m[2]!.slice(0, 4)}-${m[2]!.slice(4, 6)}-${m[2]!.slice(6)}T${m[3]!.slice(0, 2)}:${m[3]!.slice(2, 4)}:${m[3]!.slice(4)}`;
  const known = occurrences(event, localToUtc(start, zoneOf(event)) + 1).find((o) => o.id === id);
  return known ? { event, occurrence: known } : null;
}

const calendarEventGet: Handler = (args, { account, callId, out }) => {
  const requested = Array.isArray(args.properties) ? args.properties : [];
  // As the server: the computed UTC times cannot be combined with the override map.
  if (requested.includes("utcStart") && requested.includes("recurrenceOverrides")) throw new MethodError("invalidArguments");
  const wanted = ids(args);
  const list: Args[] = [];
  const notFound: string[] = [];
  const idList = wanted ?? [...account.events.keys()];
  for (const id of idList) {
    const found = resolveEvent(account, id);
    if (!found) {
      notFound.push(id);
      continue;
    }
    const view = occurrenceView(found.event, found.occurrence);
    const begin = localToUtc(view.start, zoneOf(view));
    const full: Args = { ...structuredClone(view), utcStart: formatUtc(begin), utcEnd: formatUtc(begin + durationMs(view.duration)) };
    // `utcStart` and `utcEnd` are only returned when asked for.
    if (args.properties === null || args.properties === undefined) {
      delete full.utcStart;
      delete full.utcEnd;
      list.push(full);
    } else {
      list.push(pick(full, args.properties, EVENT_PROPS));
    }
  }
  out.push(["CalendarEvent/get", { accountId: account.accountId, state: "ce-state", list, notFound }, callId]);
};

// ---- /set: the engine shared by ContactCard/set and (part 2) CalendarEvent/set ----

type Stored = Record<string, unknown> & { id: string };

interface SetSpec {
  store: Map<string, Stored>;
  /** Prefix of the ids the fake hands out (`nextId`). */
  idPrefix: string;
  /** The properties a client may write; anything else is `invalidProperties`. */
  writable: ReadonlySet<string>;
  /** The invalid properties of a whole object (after the patch, for an update); empty when it is fine. */
  invalid(object: Record<string, unknown>, account: FakeAccount): string[];
  /** Server-set properties, written after every create and update. */
  stamp(object: Stored, ctx: Ctx): void;
}

const notFoundError = { type: "notFound" };
const invalidProperties = (properties: string[]) => ({ type: "invalidProperties", properties });

/**
 * The answer of a `/set` call (RFC 8620 §5.3) for `create`, `update` and `destroy`. An update is a
 * PatchObject: each key names one top-level property and replaces it, `null` removes it; a key with
 * a `/` (a deeper path) is not supported and refused. Ids of other accounts are `notFound`.
 */
function applySet(args: Args, ctx: Ctx, spec: SetSpec): Args {
  const { account } = ctx;
  const created: Args = {};
  const notCreated: Args = {};
  const updated: Args = {};
  const notUpdated: Args = {};
  const destroyed: string[] = [];
  const notDestroyed: Args = {};
  for (const key of ["create", "update"] as const) {
    if (args[key] !== undefined && args[key] !== null && !isObject(args[key])) throw new MethodError("invalidArguments");
  }
  if (args.destroy !== undefined && args.destroy !== null && (!Array.isArray(args.destroy) || !args.destroy.every((d) => typeof d === "string"))) {
    throw new MethodError("invalidArguments");
  }

  for (const [cid, object] of Object.entries((args.create as Args | undefined) ?? {})) {
    if (!isObject(object)) {
      notCreated[cid] = invalidProperties([]);
      continue;
    }
    const unknown = Object.keys(object).filter((k) => !spec.writable.has(k));
    const bad = unknown.length > 0 ? unknown : spec.invalid(object, account);
    if (bad.length > 0) {
      notCreated[cid] = invalidProperties(bad);
      continue;
    }
    const id = ctx.state.nextId(spec.idPrefix);
    const stored: Stored = { ...structuredClone(object), id };
    spec.stamp(stored, ctx);
    spec.store.set(id, stored);
    ctx.createdIds.set(cid, id);
    created[cid] = { id };
  }

  for (const [id, patch] of Object.entries((args.update as Args | undefined) ?? {})) {
    const current = spec.store.get(id);
    if (!current) {
      notUpdated[id] = notFoundError;
      continue;
    }
    if (!isObject(patch)) {
      notUpdated[id] = invalidProperties([]);
      continue;
    }
    const unknown = Object.keys(patch).filter((k) => !spec.writable.has(k));
    if (unknown.length > 0) {
      notUpdated[id] = invalidProperties(unknown);
      continue;
    }
    const merged: Record<string, unknown> = structuredClone(current);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete merged[k];
      else merged[k] = structuredClone(v);
    }
    const bad = spec.invalid(merged, account);
    if (bad.length > 0) {
      notUpdated[id] = invalidProperties(bad);
      continue;
    }
    const stored = merged as Stored;
    spec.stamp(stored, ctx);
    spec.store.set(id, stored);
    updated[id] = null;
  }

  for (const id of (args.destroy as string[] | undefined) ?? []) {
    if (!spec.store.delete(id)) notDestroyed[id] = notFoundError;
    else destroyed.push(id);
  }

  return {
    accountId: account.accountId,
    oldState: "set-old",
    newState: "set-new",
    created: Object.keys(created).length > 0 ? created : null,
    notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
    updated: Object.keys(updated).length > 0 ? updated : null,
    notUpdated: Object.keys(notUpdated).length > 0 ? notUpdated : null,
    destroyed: destroyed.length > 0 ? destroyed : null,
    notDestroyed: Object.keys(notDestroyed).length > 0 ? notDestroyed : null,
  };
}

// ---- ContactCard/set ----

const CONTACT_WRITABLE = new Set([
  "@type", "version", "uid", "kind", "name", "nicknames", "emails", "phones", "organizations", "titles",
  "addresses", "notes", "anniversaries", "addressBookIds",
]);

/** The properties of a card that are keyed maps of objects (JSContact `Id[Object]`). */
const CONTACT_MAPS = ["nicknames", "emails", "phones", "organizations", "titles", "addresses", "notes", "anniversaries"];

function invalidCardProperties(card: Record<string, unknown>, account: FakeAccount): string[] {
  const bad: string[] = [];
  if (card["@type"] !== "Card") bad.push("@type");
  if (typeof card.version !== "string") bad.push("version");
  if (typeof card.uid !== "string" || card.uid === "") bad.push("uid");
  const books = card.addressBookIds;
  const bookIds = isObject(books) ? Object.keys(books) : [];
  if (!isObject(books) || bookIds.length === 0 || !bookIds.every((b) => books[b] === true && account.addressBooks.has(b))) {
    bad.push("addressBookIds");
  }
  if (card.name !== undefined && !isObject(card.name)) bad.push("name");
  if (isObject(card.name) && card.name.full !== undefined && typeof card.name.full !== "string") bad.push("name");
  for (const key of CONTACT_MAPS) {
    const value = card[key];
    if (value !== undefined && !(isObject(value) && Object.values(value).every(isObject))) bad.push(key);
  }
  return [...new Set(bad)];
}

const contactSet: Handler = (args, ctx) => {
  const spec: SetSpec = {
    store: ctx.account.contacts,
    idPrefix: "ct",
    writable: CONTACT_WRITABLE,
    invalid: invalidCardProperties,
    stamp: (object, c) => {
      object.updated = c.state.nextReceivedAt();
    },
  };
  ctx.out.push(["ContactCard/set", applySet(args, ctx, spec), ctx.callId]);
};

// ---- data helpers for `createFakeStalwart` ----

/** The default calendar every account has; created with the account. */
export function addDefaultCalendar(account: FakeAccount, id: string): void {
  account.calendars.set(id, { id, name: "Calendar", description: null, color: null, isDefault: true, timeZone: null, mayWrite: true });
}

/** The default address book every account has; created with the account. */
export function addDefaultAddressBook(account: FakeAccount, id: string): void {
  account.addressBooks.set(id, { id, name: "Personal", isDefault: true });
}

// ---- method table ----

/** Merged into the dispatcher's table; `area` makes a token without that scope get `unknownMethod`. */
export const COLLAB_METHODS: Record<string, MethodEntry> = {
  "AddressBook/get": { capability: CONTACTS, area: "contacts", handler: addressBookGet },
  "ContactCard/query": { capability: CONTACTS, area: "contacts", handler: contactQuery },
  "ContactCard/get": { capability: CONTACTS, area: "contacts", handler: contactGet },
  "ContactCard/set": { capability: CONTACTS, area: "contacts", handler: contactSet },
  "Calendar/get": { capability: CALENDARS, area: "calendars", handler: calendarGet },
  "CalendarEvent/query": { capability: CALENDARS, area: "calendars", handler: calendarEventQuery },
  "CalendarEvent/get": { capability: CALENDARS, area: "calendars", handler: calendarEventGet },
  // Part 2: "CalendarEvent/set" goes here, built on `applySet` with its own `SetSpec`.
};
