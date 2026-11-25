/**
 * Contacts handlers of the fake Stalwart (RFC 9610: `AddressBook/get`, `ContactCard/query`,
 * `ContactCard/get`) and the calendar ones (draft-ietf-jmap-calendars: `Calendar/get`,
 * `CalendarEvent/query`, `CalendarEvent/get`, with `expandRecurrences` and `utcStart` / `utcEnd`),
 * and the table `fake-stalwart-jmap.ts` merges into its method table.
 *
 * The write side is one shared `/set` engine (`applySet`: `create`, `update` as a PatchObject of
 * top-level properties, `destroy`) with a spec per type: `ContactCard/set` and `CalendarEvent/set`.
 *
 * Events use the property names Stalwart 1.x implements: one `recurrenceRule` object, participants
 * addressed by `calendarAddress` (`mailto:` URI), `organizerCalendarAddress`. Like the server, the
 * fake stores any other property name as inert data: `recurrenceRules`, `sendTo` and `replyTo` have
 * no effect (an event with `recurrenceRules` does not recur; a participant with only `sendTo` is
 * not an attendee). With `sendSchedulingMessages: true` it records the iTIP messages the server
 * would send (`account.scheduling`).
 *
 * Everything is scoped to the request's account: another account's ids are `notFound`.
 */
import { clock } from "../src/clock";
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

/** The parts of an ISO 8601 duration: whole days (weeks count as 7) and the exact rest in ms. */
function durationParts(duration: unknown): { days: number; restMs: number } {
  const m = typeof duration === "string" ? /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration) : null;
  if (!m) throw new MethodError("invalidArguments");
  const [w, d, h, min, sec] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number];
  return { days: w * 7 + d, restMs: ((h * 60 + min) * 60 + sec) * 1000 };
}

/**
 * The end (UTC ms) of an occurrence starting at the LocalDateTime `start` in `zone`: days are
 * nominal (wall-clock days in the zone, as RFC 5545 counts them), the rest is exact time.
 */
function endUtc(start: string, zone: string | null, duration: unknown): number {
  const { days, restMs } = durationParts(duration);
  return localToUtc(formatLocal(localMs(start) + days * DAY), zone) + restMs;
}

const zoneOf = (e: FakeEvent): string | null => (typeof e.timeZone === "string" ? e.timeZone : null);

// ---- recurrence: `recurrenceRule` (daily, weekly with byDay, monthly, yearly; interval, count,
// until) and excluded occurrences in `recurrenceOverrides` ----

interface Occurrence {
  id: string;
  /** LocalDateTime of this occurrence, in the event's zone. */
  start: string;
}

const compact = (local: string): string => local.replace(/[-:]/g, "");

/** The rule of `e`: only `recurrenceRule` counts. `recurrenceRules` (the older name) is inert data. */
function recurrenceRule(e: FakeEvent): Args | null {
  return isObject(e.recurrenceRule) ? e.recurrenceRule : null;
}

const WEEKDAY_INDEX: Record<string, number> = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };
const CANDIDATES_MAX = 5000;

/** The local starts (ms, as if UTC) a rule produces from `first`, in order, before count and until. */
function* candidateStarts(first: number, rule: Args): Generator<number> {
  const interval = typeof rule.interval === "number" ? rule.interval : 1;
  const date = new Date(first);
  const timeOfDay = first - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const byDay = Array.isArray(rule.byDay)
    ? rule.byDay.filter(isObject).map((d) => WEEKDAY_INDEX[String(d.day)]).filter((d): d is number => d !== undefined).sort()
    : [];
  for (let k = 0; k < CANDIDATES_MAX; k++) {
    if (rule.frequency === "daily") yield first + k * interval * DAY;
    else if (rule.frequency === "weekly" && byDay.length === 0) yield first + k * 7 * interval * DAY;
    else if (rule.frequency === "weekly") {
      const monday = first - timeOfDay - ((date.getUTCDay() + 6) % 7) * DAY + k * 7 * interval * DAY;
      for (const day of byDay) {
        const start = monday + day * DAY + timeOfDay;
        if (start >= first) yield start;
      }
    } else if (rule.frequency === "monthly" || rule.frequency === "yearly") {
      const months = (rule.frequency === "monthly" ? 1 : 12) * interval * k;
      const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
      // A month without that day (the 31st, 29 February) has no occurrence.
      if (target.getUTCDate() === date.getUTCDate()) yield target.getTime() + timeOfDay;
    } else {
      throw new Error(`fake-stalwart: recurrence frequency ${String(rule.frequency)} is not supported`);
    }
  }
}

const isExcluded = (e: FakeEvent, start: string): boolean => {
  const overrides = isObject(e.recurrenceOverrides) ? e.recurrenceOverrides : {};
  const override = overrides[start];
  return isObject(override) && override.excluded === true;
};

/**
 * The occurrences of `e` that start before the instant `beforeUtc`. A recurring event gets a
 * synthetic id for each, `<event id>-<YYYYMMDDTHHMMSS>`; a single event keeps its own id. An
 * excluded occurrence still counts towards the rule's `count`, but is not listed.
 */
function occurrences(e: FakeEvent, beforeUtc: number): Occurrence[] {
  const rule = recurrenceRule(e);
  if (rule === null) return localToUtc(e.start, zoneOf(e)) < beforeUtc ? [{ id: e.id, start: e.start }] : [];
  const count = typeof rule.count === "number" ? rule.count : Infinity;
  const until = typeof rule.until === "string" ? localMs(rule.until.slice(0, 19)) : Infinity;
  const found: Occurrence[] = [];
  let produced = 0;
  for (const local of candidateStarts(localMs(e.start), rule)) {
    if (produced >= count || local > until) break;
    produced++;
    const start = formatLocal(local);
    if (localToUtc(start, zoneOf(e)) >= beforeUtc) break;
    if (!isExcluded(e, start)) found.push({ id: `${e.id}-${compact(start)}`, start });
  }
  return found;
}

/** When `e` ends (UTC ms): a series without count or until never does. */
function eventEnd(e: FakeEvent): number {
  const rule = recurrenceRule(e);
  if (rule === null) return endUtc(e.start, zoneOf(e), e.duration);
  if (typeof rule.count !== "number" && typeof rule.until !== "string") return Infinity;
  const all = occurrences(e, Infinity);
  const last = all.at(-1);
  return last === undefined ? endUtc(e.start, zoneOf(e), e.duration) : endUtc(last.start, zoneOf(e), e.duration);
}

/** The event as the server shows it for one occurrence: its own start and overrides, `recurrenceId`, no rule. */
function occurrenceView(e: FakeEvent, occurrence: Occurrence): FakeEvent {
  if (occurrence.id === e.id) return e;
  const overrides = isObject(e.recurrenceOverrides) ? e.recurrenceOverrides : {};
  const override = isObject(overrides[occurrence.start]) ? (overrides[occurrence.start] as Args) : {};
  return {
    ...e,
    ...override,
    id: occurrence.id,
    start: occurrence.start,
    recurrenceId: occurrence.start,
    recurrenceRule: null,
    recurrenceOverrides: null,
  } as FakeEvent;
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
    ...values(e.participants).flatMap((p) => [text(p.name), text(p.calendarAddress), text(p.email)]),
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
  const end = endUtc(start, zoneOf(e), e.duration);
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
  "showWithoutTime", "utcStart", "utcEnd", "status", "freeBusyStatus", "privacy", "recurrenceId", "recurrenceRule",
  "recurrenceRules", "recurrenceOverrides", "locations", "virtualLocations", "participants", "organizerCalendarAddress",
  "isDraft", "created", "updated",
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
    const full: Args = { ...structuredClone(view), utcStart: formatUtc(begin), utcEnd: formatUtc(endUtc(view.start, zoneOf(view), view.duration)) };
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

// ---- /set: the engine shared by ContactCard/set and CalendarEvent/set ----

type Stored = Record<string, unknown> & { id: string };

interface SetSpec {
  store: Map<string, Stored>;
  /** Prefix of the ids the fake hands out (`nextId`). */
  idPrefix: string;
  /**
   * The properties a client may write; anything else is `invalidProperties`. Null: any name is
   * stored (as the server keeps unknown JSCalendar properties), except those in `serverSet`.
   */
  writable: ReadonlySet<string> | null;
  /** Properties only the server sets: refused in a create or update. */
  serverSet?: ReadonlySet<string>;
  /** The invalid properties of a whole object (after the patch, for an update); empty when it is fine. */
  invalid(object: Record<string, unknown>, account: FakeAccount): string[];
  /** Server-set properties, written after every create and update. */
  stamp(object: Stored, ctx: Ctx): void;
  /** A SetError for a create the server refuses for reasons beyond its properties, else null. */
  refuseCreate?(object: Stored, ctx: Ctx): Args | null;
  /** Run after a create, an update or a destroy took effect. */
  created?(object: Stored, ctx: Ctx): void;
  updated?(before: Stored, after: Stored, ctx: Ctx): void;
  destroyed?(object: Stored, ctx: Ctx): void;
}

/** The keys of a create or patch the spec refuses: unknown ones, server-set ones, nested paths. */
function refusedKeys(object: Args, spec: SetSpec): string[] {
  return Object.keys(object).filter(
    (k) => (spec.writable !== null && !spec.writable.has(k)) || spec.serverSet?.has(k) === true || k.includes("/"),
  );
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
    const unknown = refusedKeys(object, spec);
    const bad = unknown.length > 0 ? unknown : spec.invalid(object, account);
    if (bad.length > 0) {
      notCreated[cid] = invalidProperties(bad);
      continue;
    }
    const id = ctx.state.nextId(spec.idPrefix);
    const stored: Stored = { ...structuredClone(object), id };
    spec.stamp(stored, ctx);
    const refusal = spec.refuseCreate?.(stored, ctx) ?? null;
    if (refusal !== null) {
      notCreated[cid] = refusal;
      continue;
    }
    spec.store.set(id, stored);
    ctx.createdIds.set(cid, id);
    created[cid] = { id };
    spec.created?.(stored, ctx);
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
    const unknown = refusedKeys(patch, spec);
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
    spec.updated?.(current, stored, ctx);
  }

  for (const id of (args.destroy as string[] | undefined) ?? []) {
    const current = spec.store.get(id);
    if (!current || !spec.store.delete(id)) notDestroyed[id] = notFoundError;
    else {
      destroyed.push(id);
      spec.destroyed?.(current, ctx);
    }
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

// ---- CalendarEvent/set ----

/** More participants than this in one event is `invalidProperties`, as at the server. */
const PARTICIPANTS_MAX = 20;
/** Attendees at this domain cannot be reached: a scheduling create answers `noSupportedScheduleMethods`. */
const UNREACHABLE = /@unreachable\.example$/i;

/** Properties the server computes; a client must not send them. */
const EVENT_SERVER_SET = new Set(["id", "utcStart", "utcEnd", "isOrigin", "created", "updated"]);

const stripMailto = (v: unknown): string | null =>
  typeof v === "string" && /^mailto:/i.test(v) ? v.slice("mailto:".length).toLowerCase() : null;

/**
 * Whom the server schedules with: the participants addressed by `calendarAddress`, except the
 * account itself (the organizer). A participant with only `email` or `sendTo` is not one.
 */
function attendeesOf(e: Args, account: FakeAccount): string[] {
  const own = account.email.toLowerCase();
  const found = values(e.participants)
    .map((p) => stripMailto(p.calendarAddress))
    .filter((a): a is string => a !== null && a !== own);
  return [...new Set(found)];
}

const endsInPast = (e: FakeEvent): boolean => eventEnd(e) < clock.now();

/** True when a write with `sendSchedulingMessages: true` makes the server send for `e`. */
function schedules(e: FakeEvent, account: FakeAccount): boolean {
  return attendeesOf(e, account).length > 0 && e.isDraft !== true && !endsInPast(e);
}

function invalidEventProperties(e: Record<string, unknown>, account: FakeAccount): string[] {
  const bad: string[] = [];
  if (e["@type"] !== undefined && e["@type"] !== "Event") bad.push("@type");
  if (e.uid !== undefined && (typeof e.uid !== "string" || e.uid === "")) bad.push("uid");
  const calendars = e.calendarIds;
  const ids = isObject(calendars) ? Object.keys(calendars) : [];
  if (!isObject(calendars) || ids.length === 0 || !ids.every((c) => calendars[c] === true && account.calendars.has(c))) {
    bad.push("calendarIds");
  }
  if (typeof e.start !== "string" || !LOCAL.test(e.start)) bad.push("start");
  if (e.timeZone !== undefined && e.timeZone !== null && typeof e.timeZone !== "string") bad.push("timeZone");
  if (e.duration !== undefined && (typeof e.duration !== "string" || !/^P/.test(e.duration))) bad.push("duration");
  if (e.participants !== undefined) {
    const list = isObject(e.participants) ? Object.values(e.participants) : null;
    if (list === null || !list.every(isObject) || list.length > PARTICIPANTS_MAX) bad.push("participants");
  }
  if (e.recurrenceRule !== undefined && !isObject(e.recurrenceRule)) bad.push("recurrenceRule");
  if (isObject(e.recurrenceRule) && !["daily", "weekly", "monthly", "yearly"].includes(String(e.recurrenceRule.frequency))) {
    bad.push("recurrenceRule");
  }
  return [...new Set(bad)];
}

function record(ctx: Ctx, kind: "REQUEST" | "CANCEL", eventId: string, attendees: string[]): void {
  if (attendees.length > 0) ctx.account.scheduling.push({ kind, eventId, attendees: [...attendees] });
}

/** The occurrence (not a stored event) an id names: `<event id>-<YYYYMMDDTHHMMSS>` of a series. */
function occurrenceOf(account: FakeAccount, id: string): { event: FakeEvent; occurrence: Occurrence } | null {
  if (account.events.has(id)) return null;
  return resolveEvent(account, id);
}

/**
 * Updates and destroys of occurrence ids: an update becomes (or extends) that occurrence's entry
 * in `recurrenceOverrides`, a destroy marks it excluded and reports the id as destroyed. A series
 * and one of its occurrences in the same destroy is an error for the occurrence.
 */
function applyToOccurrences(args: Args, ctx: Ctx, notify: boolean): { rest: Args; answer: Args } {
  const { account } = ctx;
  const updated: Args = {};
  const notUpdated: Args = {};
  const destroyed: string[] = [];
  const notDestroyed: Args = {};
  const update: Args = {};
  for (const [id, patch] of Object.entries(isObject(args.update) ? args.update : {})) {
    const found = occurrenceOf(account, id);
    if (!found) {
      update[id] = patch;
      continue;
    }
    if (!isObject(patch) || Object.keys(patch).some((k) => EVENT_SERVER_SET.has(k) || k.includes("/") || k === "recurrenceRule")) {
      notUpdated[id] = invalidProperties(isObject(patch) ? Object.keys(patch) : []);
      continue;
    }
    const overrides = isObject(found.event.recurrenceOverrides) ? found.event.recurrenceOverrides : {};
    const before = occurrenceView(found.event, found.occurrence);
    found.event.recurrenceOverrides = { ...overrides, [found.occurrence.start]: { ...(isObject(overrides[found.occurrence.start]) ? overrides[found.occurrence.start] as Args : {}), ...structuredClone(patch) } };
    const after = occurrenceView(found.event, found.occurrence);
    updated[id] = null;
    if (notify && (schedules(before, account) || schedules(after, account))) {
      record(ctx, "REQUEST", id, attendeesOf(after, account));
      record(ctx, "CANCEL", id, attendeesOf(before, account).filter((a) => !attendeesOf(after, account).includes(a)));
    }
  }
  const destroy: string[] = [];
  const all = Array.isArray(args.destroy) ? (args.destroy as string[]) : [];
  for (const id of all) {
    const found = occurrenceOf(account, id);
    if (!found) {
      destroy.push(id);
      continue;
    }
    if (all.includes(found.event.id)) {
      notDestroyed[id] = { type: "invalidArguments" };
      continue;
    }
    const view = occurrenceView(found.event, found.occurrence);
    const overrides = isObject(found.event.recurrenceOverrides) ? found.event.recurrenceOverrides : {};
    found.event.recurrenceOverrides = { ...overrides, [found.occurrence.start]: { excluded: true } };
    destroyed.push(id);
    if (notify && schedules(view, account)) record(ctx, "CANCEL", id, attendeesOf(view, account));
  }
  return {
    rest: { ...args, update: Object.keys(update).length > 0 ? update : undefined, destroy: destroy.length > 0 ? destroy : undefined },
    answer: { updated, notUpdated, destroyed, notDestroyed },
  };
}

/** Merges the entries of two `/set` answers (maps and lists; `null` when empty). */
function mergeSetAnswers(base: Args, extra: Args): Args {
  const out: Args = { ...base };
  for (const key of ["updated", "notUpdated", "notDestroyed"] as const) {
    const merged = { ...(isObject(base[key]) ? base[key] : {}), ...(extra[key] as Args) };
    out[key] = Object.keys(merged).length > 0 ? merged : null;
  }
  const destroyed = [...(Array.isArray(base.destroyed) ? base.destroyed : []), ...(extra.destroyed as string[])];
  out.destroyed = destroyed.length > 0 ? destroyed : null;
  return out;
}

const calendarEventSet: Handler = (args, ctx) => {
  if (args.sendSchedulingMessages !== undefined && typeof args.sendSchedulingMessages !== "boolean") {
    throw new MethodError("invalidArguments");
  }
  const notify = args.sendSchedulingMessages === true;
  const { account } = ctx;
  const { rest, answer } = applyToOccurrences(args, ctx, notify);
  const spec: SetSpec = {
    store: account.events as Map<string, Stored>,
    idPrefix: "ev",
    writable: null,
    serverSet: EVENT_SERVER_SET,
    invalid: invalidEventProperties,
    stamp: (object, c) => {
      if (typeof object.uid !== "string") object.uid = c.state.nextId("ev-uid-");
      if (object["@type"] === undefined) object["@type"] = "Event";
      if (object.duration === undefined) object.duration = "PT0S";
      // As the server: attendees without an organizer get the account as organizer.
      if (attendeesOf(object, c.account).length > 0 && typeof object.organizerCalendarAddress !== "string") {
        object.organizerCalendarAddress = `mailto:${c.account.email}`;
      }
      object.updated = c.state.nextReceivedAt();
    },
    refuseCreate: (object, c) =>
      notify && schedules(object as FakeEvent, c.account) && attendeesOf(object, c.account).some((a) => UNREACHABLE.test(a))
        ? { type: "noSupportedScheduleMethods" }
        : null,
    created: (object, c) => {
      if (notify && schedules(object as FakeEvent, c.account)) record(c, "REQUEST", object.id, attendeesOf(object, c.account));
    },
    updated: (before, after, c) => {
      if (!notify || !(schedules(before as FakeEvent, c.account) || schedules(after as FakeEvent, c.account))) return;
      if (endsInPast(after as FakeEvent) || after.isDraft === true) return;
      const now = attendeesOf(after, c.account);
      record(c, "REQUEST", after.id, now);
      record(c, "CANCEL", after.id, attendeesOf(before, c.account).filter((a) => !now.includes(a)));
    },
    destroyed: (object, c) => {
      if (notify && schedules(object as FakeEvent, c.account)) record(c, "CANCEL", object.id, attendeesOf(object, c.account));
    },
  };
  ctx.out.push(["CalendarEvent/set", mergeSetAnswers(applySet(rest, ctx, spec), answer), ctx.callId]);
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
  "CalendarEvent/set": { capability: CALENDARS, area: "calendars", handler: calendarEventSet },
};
