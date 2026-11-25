/**
 * JMAP contacts and calendar objects → tool results. As in `map.ts`, upstream answers are parsed
 * with the schemas below (anything unexpected is `upstream_rejected`) and every string leaves
 * through `clean` or `cleanText`, so no path can skip the sanitizer.
 */
import { z } from "zod";
import {
  type CalendarInfo,
  COLLAB_LIMITS,
  type ContactDetail,
  type ContactSummary,
  type EventDetail,
  type EventSummary,
  type SearchContactsInputT,
  type SearchEventsInputT,
} from "../collab";
import { cleanText, htmlToText } from "../content/sanitize";
import { MailIdSchema } from "../mail";
import { clean, trueKeys } from "./map";

const LINE = COLLAB_LIMITS.lineChars;
const DETAIL_MAX = COLLAB_LIMITS.detailListMax;

// ---- contacts: a ContactCard is a JSContact Card (RFC 9553) plus `id` and `addressBookIds` ----

const Contexts = z.record(z.string(), z.boolean()).nullish();
const Component = z.object({ kind: z.string().nullish(), value: z.string().nullish() });
const Entries = <T extends z.ZodTypeAny>(item: T) => z.record(z.string(), item).nullish();

export const JmapContactCard = z.object({
  id: MailIdSchema,
  kind: z.string().nullish(),
  name: z
    .object({
      full: z.string().nullish(),
      isOrdered: z.boolean().nullish(),
      components: z.array(Component).nullish(),
    })
    .nullish(),
  nicknames: Entries(z.object({ name: z.string().nullish() })),
  emails: Entries(z.object({ address: z.string().nullish(), contexts: Contexts, label: z.string().nullish() })),
  phones: Entries(z.object({ number: z.string().nullish(), contexts: Contexts, label: z.string().nullish() })),
  organizations: Entries(
    z.object({ name: z.string().nullish(), units: z.array(z.object({ name: z.string().nullish() })).nullish() }),
  ),
  titles: Entries(z.object({ name: z.string().nullish() })),
  addresses: Entries(
    z.object({
      full: z.string().nullish(),
      components: z.array(Component).nullish(),
      contexts: Contexts,
      label: z.string().nullish(),
    }),
  ),
  notes: Entries(z.object({ note: z.string().nullish() })),
  anniversaries: Entries(
    z.object({
      kind: z.string().nullish(),
      date: z
        .object({
          year: z.number().int().nullish(),
          month: z.number().int().nullish(),
          day: z.number().int().nullish(),
          utc: z.string().nullish(),
        })
        .nullish(),
    }),
  ),
  addressBookIds: z.record(z.string(), z.boolean()).nullish(),
  updated: z.string().nullish(),
});

type Card = z.infer<typeof JmapContactCard>;

export const JmapAddressBook = z.object({ id: MailIdSchema });

export const CONTACT_SUMMARY_PROPERTIES = ["id", "kind", "name", "emails", "phones", "organizations"] as const;
export const CONTACT_DETAIL_PROPERTIES = [
  "id", "addressBookIds", "kind", "name", "nicknames", "emails", "phones", "organizations", "titles",
  "addresses", "notes", "anniversaries", "updated",
] as const;

const values = <T>(map: Record<string, T> | null | undefined): T[] => Object.values(map ?? {});

/** Non-empty cleaned strings, in order, at most `max`. */
function cleanedList(list: (string | null | undefined)[], max: number, chars: number): string[] {
  const out: string[] = [];
  for (const raw of list) {
    if (out.length >= max) break;
    const text = raw == null ? "" : clean(raw, chars).trim();
    if (text !== "") out.push(text);
  }
  return out;
}

/** The entry's own label, else its first context (`work`, `private`), else null. */
function labelOf(entry: { label?: string | null; contexts?: Record<string, boolean> | null }): string | null {
  const own = entry.label == null ? "" : clean(entry.label, LINE).trim();
  if (own !== "") return own;
  const context = trueKeys(entry.contexts)[0];
  return context === undefined ? null : clean(context, LINE);
}

const NAME_ORDER = ["title", "given", "given2", "surname", "surname2", "generation"] as const;

type NameComponent = { kind?: string | null; value?: string | null };

function nameComponents(components: NameComponent[], ordered: boolean): string[] {
  const named = components.filter((c) => c.kind != null && (NAME_ORDER as readonly string[]).includes(c.kind));
  const sorted = ordered
    ? named
    : [...named].sort((a, b) => NAME_ORDER.indexOf(a.kind as (typeof NAME_ORDER)[number]) - NAME_ORDER.indexOf(b.kind as (typeof NAME_ORDER)[number]));
  return sorted.map((c) => c.value ?? "");
}

function componentValue(card: Card, kind: string): string | null {
  const found = (card.name?.components ?? []).find((c) => c.kind === kind && c.value != null);
  const text = found?.value == null ? "" : clean(found.value, LINE).trim();
  return text === "" ? null : text;
}

function emailAddresses(card: Card, max: number): string[] {
  return cleanedList(values(card.emails).map((e) => e.address), max, LINE);
}

function organizationNames(card: Card): string[] {
  return cleanedList(values(card.organizations).map((o) => o.name), Number.MAX_SAFE_INTEGER, LINE);
}

/** `name.full`, else the name components, else the first organization, else the first email, else "". */
function contactName(card: Card): string {
  const full = card.name?.full == null ? "" : clean(card.name.full, LINE).trim();
  if (full !== "") return full;
  const joined = clean(
    nameComponents(card.name?.components ?? [], card.name?.isOrdered === true)
      .map((v) => clean(v, LINE).trim())
      .filter((v) => v !== "")
      .join(" "),
    LINE,
  ).trim();
  if (joined !== "") return joined;
  return organizationNames(card)[0] ?? emailAddresses(card, 1)[0] ?? "";
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** The anniversary of kind `birth` as `YYYY-MM-DD`, or `--MM-DD` without a year. */
function birthday(card: Card): string | null {
  const date = values(card.anniversaries).find((a) => a.kind === "birth")?.date;
  if (date == null) return null;
  if (date.utc != null) {
    const day = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(date.utc);
    return day?.[1] ?? null;
  }
  const { year, month, day } = date;
  if (month == null || day == null || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year == null) return `--${pad(month, 2)}-${pad(day, 2)}`;
  return year >= 0 && year <= 9999 ? `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` : null;
}

function addressText(a: NonNullable<Card["addresses"]>[string]): string {
  const full = a.full == null ? "" : clean(a.full, COLLAB_LIMITS.addressChars).trim();
  if (full !== "") return full;
  const parts = (a.components ?? [])
    .filter((c) => c.kind !== "separator" && c.value != null)
    .map((c) => clean(c.value ?? "", LINE).trim())
    .filter((v) => v !== "");
  return clean(parts.join(", "), COLLAB_LIMITS.addressChars).trim();
}

export function toContactSummary(card: Card): ContactSummary {
  return {
    id: card.id,
    name: contactName(card),
    emails: emailAddresses(card, COLLAB_LIMITS.summaryEmailsMax),
    phones: cleanedList(values(card.phones).map((p) => p.number), COLLAB_LIMITS.summaryPhonesMax, LINE),
    organization: organizationNames(card)[0] ?? null,
    kind: clean(card.kind ?? "individual", LINE),
  };
}

export function toContactDetail(card: Card): ContactDetail {
  const notes = cleanText(
    values(card.notes)
      .map((n) => n.note ?? "")
      .filter((n) => n.trim() !== "")
      .join("\n\n"),
    COLLAB_LIMITS.notesChars,
  );
  return {
    id: card.id,
    kind: clean(card.kind ?? "individual", LINE),
    name: contactName(card),
    given_name: componentValue(card, "given"),
    surname: componentValue(card, "surname"),
    nicknames: cleanedList(values(card.nicknames).map((n) => n.name), DETAIL_MAX, LINE),
    emails: values(card.emails)
      .map((e) => ({ address: e.address == null ? "" : clean(e.address, LINE).trim(), label: labelOf(e) }))
      .filter((e) => e.address !== "")
      .slice(0, DETAIL_MAX),
    phones: values(card.phones)
      .map((p) => ({ number: p.number == null ? "" : clean(p.number, LINE).trim(), label: labelOf(p) }))
      .filter((p) => p.number !== "")
      .slice(0, DETAIL_MAX),
    organizations: values(card.organizations)
      .map((o) => ({
        name: o.name == null || clean(o.name, LINE).trim() === "" ? null : clean(o.name, LINE).trim(),
        units: cleanedList((o.units ?? []).map((u) => u.name), DETAIL_MAX, LINE),
      }))
      .filter((o) => o.name !== null || o.units.length > 0)
      .slice(0, DETAIL_MAX),
    titles: cleanedList(values(card.titles).map((t) => t.name), DETAIL_MAX, LINE),
    addresses: values(card.addresses)
      .map((a) => ({ text: addressText(a), label: labelOf(a) }))
      .filter((a) => a.text !== "")
      .slice(0, DETAIL_MAX),
    birthday: birthday(card),
    notes: notes.text,
    notes_truncated: notes.truncated,
    address_book_ids: idKeys(card.addressBookIds),
    updated: card.updated == null ? null : clean(card.updated, 64),
  };
}

/** Search input → JMAP `ContactCard/query` FilterCondition. */
export function contactFilter(input: SearchContactsInputT): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (input.text !== undefined) f.text = input.text;
  if (input.name !== undefined) f.name = input.name;
  if (input.email !== undefined) f.email = input.email;
  if (input.phone !== undefined) f.phone = input.phone;
  if (input.organization !== undefined) f.organization = input.organization;
  if (input.address_book_id !== undefined) f.inAddressBook = input.address_book_id;
  return f;
}

// ---- calendars: a CalendarEvent is a JSCalendar Event (RFC 8984) plus `id`, `calendarIds` and the
// server-computed `utcStart` / `utcEnd` (draft-ietf-jmap-calendars) ----

export const JmapCalendar = z.object({
  id: MailIdSchema,
  name: z.string().nullish(),
  description: z.string().nullish(),
  color: z.string().nullish(),
  isDefault: z.boolean().nullish(),
  timeZone: z.string().nullish(),
  myRights: z.object({ mayWriteAll: z.boolean().nullish(), mayWriteOwn: z.boolean().nullish() }).nullish(),
});

export const JmapCalendarEvent = z.object({
  id: MailIdSchema,
  calendarIds: z.record(z.string(), z.boolean()).nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  descriptionContentType: z.string().nullish(),
  start: z.string().nullish(),
  timeZone: z.string().nullish(),
  duration: z.string().nullish(),
  showWithoutTime: z.boolean().nullish(),
  utcStart: z.string().nullish(),
  utcEnd: z.string().nullish(),
  status: z.string().nullish(),
  freeBusyStatus: z.string().nullish(),
  privacy: z.string().nullish(),
  recurrenceId: z.string().nullish(),
  recurrenceRules: z
    .array(
      z.object({
        frequency: z.string().nullish(),
        interval: z.number().int().nullish(),
        count: z.number().int().nullish(),
        until: z.string().nullish(),
      }),
    )
    .nullish(),
  locations: Entries(z.object({ name: z.string().nullish() })),
  virtualLocations: Entries(z.object({ uri: z.string().nullish(), name: z.string().nullish() })),
  participants: Entries(
    z.object({
      name: z.string().nullish(),
      email: z.string().nullish(),
      sendTo: z.object({ imip: z.string().nullish() }).nullish(),
      roles: z.record(z.string(), z.boolean()).nullish(),
      participationStatus: z.string().nullish(),
    }),
  ),
});

type CalendarEventObject = z.infer<typeof JmapCalendarEvent>;

export const CALENDAR_PROPERTIES = ["id", "name", "description", "color", "isDefault", "timeZone", "myRights"] as const;

// `recurrenceOverrides` is never requested: the server answers `invalidArguments` when it comes
// together with `utcStart`.
const EVENT_SUMMARY_PROPERTIES = [
  "id", "calendarIds", "title", "start", "timeZone", "duration", "showWithoutTime", "utcStart", "utcEnd",
  "status", "locations", "recurrenceId", "recurrenceRules",
] as const;
export const EVENT_SUMMARY_REQUEST = EVENT_SUMMARY_PROPERTIES;
export const EVENT_DETAIL_PROPERTIES = [
  ...EVENT_SUMMARY_PROPERTIES, "description", "descriptionContentType", "virtualLocations", "participants",
  "freeBusyStatus", "privacy",
] as const;

/** The zone the server computes `utcStart` / `utcEnd` for and reads the query's bounds in. */
export const EVENT_TIME_ZONE = "Etc/UTC";

export function toCalendarInfo(c: z.infer<typeof JmapCalendar>): CalendarInfo {
  const optional = (v: string | null | undefined, chars: number): string | null => {
    const text = v == null ? "" : clean(v, chars).trim();
    return text === "" ? null : text;
  };
  return {
    id: c.id,
    name: c.name == null ? "" : clean(c.name, LINE).trim(),
    description: optional(c.description, COLLAB_LIMITS.notesChars),
    color: optional(c.color, 64),
    is_default: c.isDefault === true,
    time_zone: optional(c.timeZone, 64),
    can_write: c.myRights?.mayWriteAll === true || c.myRights?.mayWriteOwn === true,
  };
}

const optionalLine = (v: string | null | undefined, chars = 64): string | null => {
  const text = v == null ? "" : clean(v, chars).trim();
  return text === "" ? null : text;
};

function locationNames(e: CalendarEventObject, max: number): string[] {
  return cleanedList(values(e.locations).map((l) => l.name), max, LINE);
}

function isRecurring(e: CalendarEventObject): boolean {
  return e.recurrenceId != null || (e.recurrenceRules ?? []).length > 0;
}

/** The ids of a JMAP id map, as far as they are well-formed ids: nothing else is passed on. */
function idKeys(map: Parameters<typeof trueKeys>[0]): string[] {
  return trueKeys(map)
    .filter((id) => MailIdSchema.safeParse(id).success)
    .slice(0, DETAIL_MAX);
}

export function toEventSummary(e: CalendarEventObject): EventSummary {
  return {
    id: e.id,
    calendar_ids: idKeys(e.calendarIds),
    title: e.title == null ? "" : clean(e.title, LINE).trim(),
    start: optionalLine(e.utcStart),
    end: optionalLine(e.utcEnd),
    local_start: optionalLine(e.start),
    time_zone: optionalLine(e.timeZone),
    all_day: e.showWithoutTime === true,
    location: locationNames(e, 1)[0] ?? null,
    status: optionalLine(e.status),
    recurring: isRecurring(e),
  };
}

/** A short plain summary of the first rule, from its own fields only: `weekly, every 2, until 2027-01-01`. */
function recurrenceSummary(e: CalendarEventObject): string | null {
  const rule = (e.recurrenceRules ?? [])[0];
  if (rule == null) return null;
  const parts = [optionalLine(rule.frequency, 32) ?? "recurring"];
  if (rule.interval != null && rule.interval > 1) parts.push(`every ${rule.interval}`);
  if (rule.count != null) parts.push(`${rule.count} times`);
  if (rule.until != null) {
    const until = clean(rule.until, 64).trim();
    // A rule that ends at the start of a day reads as that date.
    const day = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z?$/.exec(until);
    parts.push(`until ${day?.[1] ?? until}`);
  }
  return parts.join(", ");
}

const ROLES = ["chair", "owner", "attendee", "optional", "informational"] as const;

function onlineMeetings(e: CalendarEventObject): string[] {
  const out: string[] = [];
  for (const v of values(e.virtualLocations)) {
    if (out.length >= COLLAB_LIMITS.onlineMeetingsMax) break;
    if (v.uri == null) continue;
    const uri = clean(v.uri, COLLAB_LIMITS.urlChars + 1).trim();
    if (uri === "" || uri.length > COLLAB_LIMITS.urlChars || /\s/.test(uri)) continue;
    try {
      const { protocol, username, password } = new URL(uri);
      // No `user@host` links: `https://meet.example@evil.example/` shows one host and opens another.
      if ((protocol === "http:" || protocol === "https:") && username === "" && password === "") out.push(uri);
    } catch {
      // not a URL: dropped
    }
  }
  return out;
}

export function toEventDetail(e: CalendarEventObject): EventDetail {
  const raw = e.description ?? "";
  const description = cleanText(
    e.descriptionContentType?.toLowerCase().startsWith("text/html") === true ? htmlToText(raw) : raw,
    COLLAB_LIMITS.descriptionChars,
  );
  const people = values(e.participants);
  return {
    ...toEventSummary(e),
    description: description.text,
    description_truncated: description.truncated,
    locations: locationNames(e, COLLAB_LIMITS.locationsMax),
    online_meetings: onlineMeetings(e),
    participants: people.slice(0, COLLAB_LIMITS.participantsMax).map((p) => ({
      name: optionalLine(p.name, LINE),
      email: optionalLine(p.email ?? p.sendTo?.imip?.replace(/^mailto:/i, ""), 320),
      role: ROLES.find((r) => p.roles?.[r] === true) ?? null,
      status: optionalLine(p.participationStatus),
    })),
    participants_omitted: Math.max(0, people.length - COLLAB_LIMITS.participantsMax),
    recurrence: recurrenceSummary(e),
    free_busy: optionalLine(e.freeBusyStatus),
    privacy: optionalLine(e.privacy),
  };
}

/** An instant as a JMAP LocalDateTime in UTC: `YYYY-MM-DDTHH:MM:SS`, no offset and no `Z`. */
function localDateTimeUtc(instant: string): string {
  return new Date(instant).toISOString().slice(0, 19);
}

/** Search input → JMAP `CalendarEvent/query` FilterCondition (one condition, as `expandRecurrences` needs). */
export function eventFilter(input: SearchEventsInputT): Record<string, unknown> {
  const f: Record<string, unknown> = {
    after: localDateTimeUtc(input.after),
    before: localDateTimeUtc(input.before),
  };
  if (input.calendar_id !== undefined) f.inCalendar = input.calendar_id;
  if (input.text !== undefined) f.text = input.text;
  return f;
}
