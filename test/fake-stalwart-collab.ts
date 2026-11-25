/**
 * Contacts handlers of the fake Stalwart (RFC 9610: `AddressBook/get`, `ContactCard/query`,
 * `ContactCard/get`), and the table `fake-stalwart-jmap.ts` merges into its method table.
 * Calendar handlers (`Calendar/get`, `CalendarEvent/query`, `CalendarEvent/get`) plug in below, in
 * `COLLAB_METHODS`, with `capability: COLLAB_CAPABILITIES.calendars` and `area: "calendars"`.
 *
 * Everything is scoped to the request's account: another account's ids are `notFound`.
 */
import type { FakeAccount, FakeContact } from "./fake-stalwart-state";
import {
  type Args,
  contains,
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

// ---- data helpers for `createFakeStalwart` ----

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
  // Calendars: add "Calendar/get", "CalendarEvent/query" and "CalendarEvent/get" here (part 2).
};
