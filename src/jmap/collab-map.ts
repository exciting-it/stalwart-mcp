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
  type CreateContactInputT,
  type CreateEventInputT,
  type EventAudience,
  type EventRecurrenceT,
  type StoredParticipant,
  type UpdateEventInputT,
  type UpdateContactInputT,
  WEEKDAYS,
  type ContactSummary,
  type EventDetail,
  type EventSummary,
  type SearchContactsInputT,
  type SearchEventsInputT,
} from "../collab";
import { cleanText, htmlToText } from "../content/sanitize";
import { MailError, MailIdSchema } from "../mail";
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

/** An address book or calendar as the write calls list it: its id and whether it is the default. */
export const JmapTarget = z.object({ id: MailIdSchema, isDefault: z.boolean().nullish() });

/**
 * Where a new object goes: `requested` when it is one of `list` (else `not_found`), otherwise the
 * default one, otherwise the first; an empty list is `mailbox_unsupported`.
 */
export function chooseTarget(list: { id: string; isDefault?: boolean | null }[], requested?: string): string {
  if (requested !== undefined) {
    if (!list.some((t) => t.id === requested)) throw new MailError("not_found");
    return requested;
  }
  const target = list.find((t) => t.isDefault === true) ?? list[0];
  if (!target) throw new MailError("mailbox_unsupported");
  return target.id;
}

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

// ---- contacts: writing ----

type Fields = Omit<UpdateContactInputT, "contact_id">;

const contexts = (label: "work" | "private" | undefined) => (label === undefined ? {} : { contexts: { [label]: true } });

/** `name.full` is the input `name`, else the given name and surname joined; components for the parts given. */
function nameProperty(f: Fields): Record<string, unknown> {
  const parts = [
    ...(f.given_name === undefined ? [] : [{ kind: "given", value: f.given_name }]),
    ...(f.surname === undefined ? [] : [{ kind: "surname", value: f.surname }]),
  ];
  const full = f.name ?? parts.map((p) => p.value).join(" ");
  return parts.length === 0 ? { full } : { full, components: parts, isOrdered: true };
}

const nameGiven = (f: Fields): boolean => f.name !== undefined || f.given_name !== undefined || f.surname !== undefined;

function birthdayProperty(birthday: string): Record<string, unknown> {
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(birthday)!;
  const date = { ...(m[1] === undefined ? {} : { year: Number(m[1]) }), month: Number(m[2]), day: Number(m[3]) };
  return { a1: { kind: "birth", date } };
}

const numbered = <T>(prefix: string, list: T[]): Record<string, T> =>
  Object.fromEntries(list.map((item, i) => [`${prefix}${i + 1}`, item]));

/** The JSContact properties of the fields that were given, each in the shape of a whole property. */
function contactProperties(f: Fields, clearWith: null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (nameGiven(f)) out.name = nameProperty(f);
  if (f.emails !== undefined) {
    out.emails =
      f.emails.length === 0 ? clearWith : numbered("e", f.emails.map((e) => ({ address: e.address, ...contexts(e.label) })));
  }
  if (f.phones !== undefined) {
    out.phones =
      f.phones.length === 0 ? clearWith : numbered("p", f.phones.map((p) => ({ number: p.number, ...contexts(p.label) })));
  }
  if (f.organization !== undefined) out.organizations = f.organization === "" ? clearWith : { o1: { name: f.organization } };
  if (f.job_title !== undefined) out.titles = f.job_title === "" ? clearWith : { t1: { name: f.job_title, kind: "title" } };
  if (f.notes !== undefined) out.notes = f.notes === "" ? clearWith : { n1: { note: f.notes } };
  if (f.birthday !== undefined) out.anniversaries = birthdayProperty(f.birthday);
  return out;
}

/** A new JSContact Card (RFC 9553) in `addressBookId`; only the properties whose input was given. */
export function newContactCard(input: CreateContactInputT, addressBookId: string): Record<string, unknown> {
  const { address_book_id: _book, ...fields } = input;
  const properties = contactProperties(fields, undefined);
  for (const key of Object.keys(properties)) if (properties[key] === undefined) delete properties[key];
  return {
    "@type": "Card",
    version: "1.0",
    uid: crypto.randomUUID(),
    kind: "individual",
    addressBookIds: { [addressBookId]: true },
    ...properties,
  };
}

/** The PatchObject of an update: one top-level key per given field; an emptied list or text is `null`. */
export function contactPatch(input: UpdateContactInputT): Record<string, unknown> {
  const { contact_id: _id, ...fields } = input;
  return contactProperties(fields, null);
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

const Rule = z.object({
  frequency: z.string().nullish(),
  interval: z.number().int().nullish(),
  count: z.number().int().nullish(),
  until: z.string().nullish(),
  /** RFC 8984 `NDay`: a weekday, with `nthOfPeriod` the n-th one of the month or year (negative: from the end). */
  byDay: z.array(z.object({ day: z.string().nullish(), nthOfPeriod: z.number().int().nullish() })).nullish(),
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
  /** Server-set: the series an occurrence belongs to; null (or, on older servers, its own id) for a stored event. */
  baseEventId: MailIdSchema.nullish(),
  recurrenceRule: Rule.nullish(),
  /** The older JSCalendar name (an array); Stalwart uses `recurrenceRule`. Read as a fallback only. */
  recurrenceRules: z.array(Rule).nullish(),
  locations: Entries(z.object({ name: z.string().nullish() })),
  virtualLocations: Entries(z.object({ uri: z.string().nullish(), name: z.string().nullish() })),
  participants: Entries(
    z.object({
      name: z.string().nullish(),
      calendarAddress: z.string().nullish(),
      email: z.string().nullish(),
      sendTo: z.object({ imip: z.string().nullish() }).nullish(),
      roles: z.record(z.string(), z.boolean()).nullish(),
      participationStatus: z.string().nullish(),
    }),
  ),
  organizerCalendarAddress: z.string().nullish(),
});

export type CalendarEventObject = z.infer<typeof JmapCalendarEvent>;

export const CALENDAR_PROPERTIES = ["id", "name", "description", "color", "isDefault", "timeZone", "myRights"] as const;

// `recurrenceOverrides` is never requested: the server answers `invalidArguments` when it comes
// together with `utcStart`.
const EVENT_SUMMARY_PROPERTIES = [
  "id", "calendarIds", "title", "start", "timeZone", "duration", "showWithoutTime", "utcStart", "utcEnd",
  "status", "locations", "recurrenceId", "recurrenceRule", "recurrenceRules",
] as const;
export const EVENT_SUMMARY_REQUEST = EVENT_SUMMARY_PROPERTIES;
export const EVENT_DETAIL_PROPERTIES = [
  ...EVENT_SUMMARY_PROPERTIES, "description", "descriptionContentType", "virtualLocations", "participants",
  "freeBusyStatus", "privacy", "baseEventId",
] as const;
/** What is read of the series of an occurrence: its rule. */
export const EVENT_RULE_PROPERTIES = ["id", "recurrenceRule", "recurrenceRules"] as const;

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

/** The rule of a series: `recurrenceRule`, else the first of the older `recurrenceRules`. */
const ruleOf = (e: CalendarEventObject) => e.recurrenceRule ?? (e.recurrenceRules ?? [])[0] ?? null;

function isRecurring(e: CalendarEventObject): boolean {
  return e.recurrenceId != null || ruleOf(e) !== null;
}

/**
 * The id of the series `e` is one occurrence of, when its rule has to be read from there: the
 * server shows an occurrence without the rule and names its series in `baseEventId`.
 */
export function seriesIdOf(e: CalendarEventObject): string | null {
  const base = e.baseEventId ?? null;
  return base === null || base === e.id || ruleOf(e) !== null ? null : base;
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

/** How many weekdays of a rule the summary names; a rule from elsewhere may list any number. */
const SUMMARY_DAYS_MAX = 14;

/**
 * The weekdays of a rule in the words `create_event` takes (`mo th`), an n-th one with its number
 * (`2tu`, `-1fr` for the last Friday). Only the seven names and a number a calendar can have are
 * passed on; an entry that is anything else is left out.
 */
function ruleWeekdays(rule: z.infer<typeof Rule>): string | null {
  const days: string[] = [];
  for (const entry of rule.byDay ?? []) {
    const day = WEEKDAYS.find((name) => name === entry.day?.toLowerCase());
    const nth = entry.nthOfPeriod ?? null;
    if (day === undefined || (nth !== null && (nth === 0 || Math.abs(nth) > 53))) continue;
    const text = `${nth ?? ""}${day}`;
    if (!days.includes(text)) days.push(text);
  }
  if (days.length === 0) return null;
  const named = days.slice(0, SUMMARY_DAYS_MAX).join(" ");
  return days.length > SUMMARY_DAYS_MAX ? `${named} and more` : named;
}

/** A short plain summary of the rule, from its own fields only: `weekly, every 2, on mo th, until 2027-01-01`. */
function recurrenceSummary(e: CalendarEventObject): string | null {
  const rule = ruleOf(e);
  if (rule == null) return null;
  const parts = [optionalLine(rule.frequency, 32) ?? "recurring"];
  if (rule.interval != null && rule.interval > 1) parts.push(`every ${rule.interval}`);
  const days = ruleWeekdays(rule);
  if (days !== null) parts.push(`on ${days}`);
  if (rule.count != null) parts.push(`${rule.count} times`);
  if (rule.until != null) {
    const until = clean(rule.until, 64).trim();
    // A rule that ends at the start or the end of a day reads as that date.
    const day = /^(\d{4}-\d{2}-\d{2})T(?:00:00:00|23:59:59)(?:\.0+)?Z?$/.exec(until);
    parts.push(`until ${day?.[1] ?? until}`);
  }
  return parts.join(", ");
}

/** Role names in the order they are reported; `required` (RFC 8984's name) is reported as `attendee`. */
const ROLES = ["chair", "owner", "required", "attendee", "optional", "informational"] as const;

function roleOf(roles: Record<string, boolean> | null | undefined): string | null {
  const role = ROLES.find((r) => roles?.[r] === true);
  return role === undefined ? null : role === "required" ? "attendee" : role;
}

const stripMailto = (uri: string): string => uri.replace(/^mailto:/i, "");

/** A participant's address: `calendarAddress` (a `mailto:` URI), else `email`, else `sendTo.imip`. */
function participantAddress(p: NonNullable<CalendarEventObject["participants"]>[string]): string | null | undefined {
  if (p.calendarAddress != null) return stripMailto(p.calendarAddress);
  return p.email ?? (p.sendTo?.imip == null ? null : stripMailto(p.sendTo.imip));
}

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

/** `series`: the series `e` is an occurrence of, when it was read; its rule describes the occurrence too. */
export function toEventDetail(e: CalendarEventObject, series: CalendarEventObject | null = null): EventDetail {
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
      email: optionalLine(participantAddress(p), 320),
      role: roleOf(p.roles),
      status: optionalLine(p.participationStatus),
    })),
    participants_omitted: Math.max(0, people.length - COLLAB_LIMITS.participantsMax),
    recurrence: recurrenceSummary(e) ?? (series === null ? null : recurrenceSummary(series)),
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

// ---- calendars: writing ----

const DAY_MS = 86_400_000;

/**
 * The wall-clock time of `instant` in `zone` as a JMAP LocalDateTime (`YYYY-MM-DDTHH:MM:SS`). Only
 * a year of the common era from 1000 to 9999 has the four digits a LocalDateTime needs; any other
 * (and a zone the runtime does not know) is `invalid_input`, never a wrong year.
 */
function wallClock(instant: number, zone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
  } catch {
    throw new MailError("invalid_input");
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(part("year"));
  if (part("era") !== "AD" || !Number.isInteger(year) || year < 1000 || year > 9999) throw new MailError("invalid_input");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

/** A LocalDateTime read as if it were UTC (ms): only for arithmetic on wall-clock times. */
const asUtc = (local: string): number => Date.parse(`${local}Z`);

/**
 * The instant of a LocalDateTime in `zone`. A wall-clock time that occurs twice (the hour the
 * clocks go back) is its FIRST occurrence, as RFC 5545 and RFC 8984 read it. One that does not
 * occur (the hour the clocks skip) is read with the offset before the change, so an hour later.
 */
function instantOf(local: string, zone: string): number {
  const guess = asUtc(local);
  const offset = (t: number) => asUtc(wallClock(t, zone)) - t;
  // The offsets in force within a day of `local`: each that maps back to `local` is a reading of it.
  const readings = [...new Set([offset(guess - DAY_MS), offset(guess), offset(guess + DAY_MS)])]
    .map((o) => guess - o)
    .filter((t) => wallClock(t, zone) === local);
  if (readings.length > 0) return Math.min(...readings);
  const first = guess - offset(guess);
  return guess - offset(first);
}

/**
 * An ISO 8601 duration from `start` to `end` as JSCalendar reads it in `zone`: whole days are
 * nominal (wall-clock days, as RFC 5545 counts them), the rest is exact time. No zero parts.
 */
function eventDuration(start: number, end: number, zone: string): string {
  const startLocal = wallClock(start, zone);
  let days = Math.floor((asUtc(wallClock(end, zone)) - asUtc(startLocal)) / DAY_MS);
  let rest = end - instantOf(new Date(asUtc(startLocal) + days * DAY_MS).toISOString().slice(0, 19), zone);
  while (rest < 0 && days > 0) {
    days--;
    rest = end - instantOf(new Date(asUtc(startLocal) + days * DAY_MS).toISOString().slice(0, 19), zone);
  }
  const seconds = Math.round(rest / 1000);
  const [h, m, sec] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  const time = `${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${sec > 0 ? `${sec}S` : ""}`;
  return `P${days > 0 ? `${days}D` : ""}${time === "" ? "" : `T${time}`}`;
}

type EventTime = Pick<CreateEventInputT, "start" | "end" | "time_zone" | "date" | "days">;

/**
 * The four time properties of an event, from the timed or the all-day form of the input. A time
 * without `time_zone` is in `defaultZone`: UTC for a new event, the event's own zone for an update.
 */
function timeProperties(t: EventTime, defaultZone: string = EVENT_TIME_ZONE): Record<string, unknown> {
  if (t.date !== undefined) {
    return { start: `${t.date}T00:00:00`, timeZone: null, duration: `P${t.days ?? 1}D`, showWithoutTime: true };
  }
  const zone = t.time_zone ?? defaultZone;
  const start = Date.parse(t.start!);
  return {
    start: wallClock(start, zone),
    timeZone: zone,
    duration: eventDuration(start, Date.parse(t.end!), zone),
    showWithoutTime: false,
  };
}

const mailto = (address: string): string => `mailto:${address}`;

/**
 * The participants of an event the mailbox organizes: the mailbox itself as owner, then each
 * attendee as required. `calendarAddress` is what the server schedules by. An attendee already on
 * the event (`kept`, by address) keeps the answer it gave, and its name when none is given; a new
 * one starts as not yet answered and asked to reply.
 */
function participantsProperty(
  owner: string,
  attendees: NonNullable<CreateEventInputT["participants"]>,
  kept: StoredParticipant[] = [],
): Record<string, unknown> {
  const stored = new Map(kept.map((p) => [p.email.toLowerCase(), p]));
  const out: Record<string, unknown> = {
    o: {
      "@type": "Participant",
      calendarAddress: mailto(owner),
      roles: { owner: true },
      participationStatus: "accepted",
    },
  };
  attendees.forEach((p, i) => {
    const before = stored.get(p.email.toLowerCase());
    const name = p.name ?? before?.name ?? undefined;
    const status = before?.status ?? "needs-action";
    out[`p${i + 1}`] = {
      "@type": "Participant",
      calendarAddress: mailto(p.email),
      ...(name === undefined ? {} : { name }),
      roles: { required: true },
      participationStatus: status,
      ...(status === "needs-action" ? { expectReply: true } : {}),
    };
  });
  return out;
}

/** The JSCalendar `recurrenceRule`; `until` is the end of that day in the event's zone. */
function recurrenceRuleProperty(rule: EventRecurrenceT): Record<string, unknown> {
  return {
    "@type": "RecurrenceRule",
    frequency: rule.frequency,
    interval: rule.interval ?? 1,
    ...(rule.count === undefined ? {} : { count: rule.count }),
    ...(rule.until === undefined ? {} : { until: `${rule.until}T23:59:59` }),
    ...(rule.by_day === undefined ? {} : { byDay: rule.by_day.map((day) => ({ "@type": "NDay", day })) }),
  };
}

/** True when `participants` names the mailbox's own address: it is the organizer, never an attendee. */
export function namesOwner(participants: { email: string }[] | undefined, owner: string): boolean {
  return (participants ?? []).some((p) => p.email.toLowerCase() === owner.toLowerCase());
}

/**
 * A new JSCalendar Event (RFC 8984) in `calendarId`, with the property names Stalwart uses. No
 * `uid`: the server makes one. With participants, the mailbox (`owner`) is the organizer.
 */
export function newCalendarEvent(input: CreateEventInputT, calendarId: string, owner: string): Record<string, unknown> {
  const event: Record<string, unknown> = {
    "@type": "Event",
    calendarIds: { [calendarId]: true },
    title: input.title,
    ...timeProperties(input),
  };
  if (input.description !== undefined) event.description = input.description;
  if (input.location !== undefined && input.location !== "") event.locations = { l1: { "@type": "Location", name: input.location } };
  if ((input.participants ?? []).length > 0) {
    event.organizerCalendarAddress = mailto(owner);
    event.participants = participantsProperty(owner, input.participants!);
  }
  if (input.recurrence !== undefined) event.recurrenceRule = recurrenceRuleProperty(input.recurrence);
  return event;
}

/**
 * The PatchObject of an update: one top-level key per given field, each replacing the whole
 * property. `current` is the stored event as `toEventAudience` read it: a new time without
 * `time_zone` stays in the event's own zone (UTC only for a floating event), and attendees that
 * stay keep their answers.
 */
export function eventPatch(input: UpdateEventInputT, owner: string, current?: EventAudience): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.start !== undefined || input.date !== undefined) {
    Object.assign(patch, timeProperties(input, current?.timeZone ?? EVENT_TIME_ZONE));
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) {
    patch.locations = input.location === "" ? null : { l1: { "@type": "Location", name: input.location } };
  }
  if (input.calendar_id !== undefined) patch.calendarIds = { [input.calendar_id]: true };
  if (input.participants !== undefined) {
    const none = input.participants.length === 0;
    patch.participants = none ? null : participantsProperty(owner, input.participants, current?.participants);
    patch.organizerCalendarAddress = none ? null : mailto(owner);
  }
  if (input.recurrence !== undefined) patch.recurrenceRule = input.recurrence === null ? null : recurrenceRuleProperty(input.recurrence);
  return patch;
}

/** What `eventAudiences` reads of each event. */
export const EVENT_AUDIENCE_PROPERTIES = [
  "id", "participants", "organizerCalendarAddress", "utcEnd", "timeZone", "showWithoutTime", "recurrenceId",
  "recurrenceRule", "recurrenceRules",
] as const;

const addressOf = (uri: string | null | undefined): string => (uri == null ? "" : stripMailto(uri).trim().toLowerCase());

/**
 * Whom the server would notify about `e`: every participant with a calendar address, and the
 * organizer, except the mailbox itself (`owner`); and when the event ends. A floating or all-day
 * event's end is read with a day to spare, so it is never taken for past too early. The mailbox
 * organizes the event when the organizer is its own address or there is none.
 */
export function toEventAudience(e: CalendarEventObject, owner: string): EventAudience {
  const own = owner.toLowerCase();
  const organizer = addressOf(e.organizerCalendarAddress);
  const people = values(e.participants).map((p) => ({ p, email: addressOf(p.calendarAddress) }));
  const addresses = [...people.map((x) => x.email), organizer].filter((a) => a !== "" && a !== own);
  const end = e.utcEnd == null ? Number.NaN : Date.parse(e.utcEnd);
  const floating = e.timeZone == null || e.showWithoutTime === true;
  const participants = new Map<string, StoredParticipant>();
  for (const { p, email } of people) {
    if (email === "" || email === own || participants.has(email)) continue;
    participants.set(email, { email, name: p.name ?? null, status: p.participationStatus ?? null });
  }
  return {
    attendees: [...new Set(addresses)],
    end: Number.isNaN(end) ? null : end + (floating ? DAY_MS : 0),
    recurring: isRecurring(e),
    organizedByMailbox: organizer === "" || organizer === own,
    timeZone: floating ? null : (e.timeZone ?? null),
    participants: [...participants.values()],
  };
}
