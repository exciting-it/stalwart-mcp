/**
 * JMAP contacts and calendar objects → tool results. As in `map.ts`, upstream answers are parsed
 * with the schemas below (anything unexpected is `upstream_rejected`) and every string leaves
 * through `clean` or `cleanText`, so no path can skip the sanitizer.
 */
import { z } from "zod";
import { COLLAB_LIMITS, type ContactDetail, type ContactSummary, type SearchContactsInputT } from "../collab";
import { cleanText } from "../content/sanitize";
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
    address_book_ids: trueKeys(card.addressBookIds).slice(0, DETAIL_MAX),
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
