/**
 * In-memory `MailboxAdapter` for the tool layer: two accounts (A and B) with folders, messages
 * and threads. An id that belongs to the other account answers `MailError("not_found")`, as the
 * real adapter does, and every call is recorded with the account id it ran against.
 */
import type {
  CalendarInfo,
  ContactDetail,
  ContactSummary,
  EventDetail,
  EventSummary,
  Mailbox,
  UpdateContactInputT,
} from "../src/collab";
import {
  MailError,
  type MailFolder,
  type MailSummary,
  type OutgoingMessage,
  type ThreadMessage,
} from "../src/mail";

type AccountKey = "A" | "B";

interface StoredMessage {
  id: string;
  threadId: string;
  folderId: string;
  subject: string;
  body: string;
  date: string;
}

interface Account {
  accountId: string;
  email: string;
  folders: MailFolder[];
  messages: StoredMessage[];
  contacts: ContactDetail[];
  calendars: CalendarInfo[];
  events: EventDetail[];
}

export interface FakeCall {
  accountId: string;
  method: keyof Mailbox;
}

export interface FakeIds {
  accountId: string;
  email: string;
  folderId: string;
  messageId: string;
  threadId: string;
  contactId: string;
  addressBookId: string;
  calendarId: string;
  eventId: string;
}

const folder = (id: string, name: string, role: string | null): MailFolder => ({
  id,
  name,
  role,
  parent_id: null,
  total: 1,
  unread: 0,
});

const summaryOfContact = (c: ContactDetail): ContactSummary => ({
  id: c.id,
  name: c.name,
  emails: c.emails.map((e) => e.address).slice(0, 5),
  phones: c.phones.map((n) => n.number).slice(0, 5),
  organization: c.organizations[0]?.name ?? null,
  kind: c.kind,
});

const summaryOfEvent = (e: EventDetail): EventSummary => ({
  id: e.id,
  calendar_ids: e.calendar_ids,
  title: e.title,
  start: e.start,
  end: e.end,
  local_start: e.local_start,
  time_zone: e.time_zone,
  all_day: e.all_day,
  location: e.location,
  status: e.status,
  recurring: e.recurring,
  series_id: e.series_id,
});

const emptyContact = (id: string, book: string): ContactDetail => ({
  id,
  kind: "individual",
  name: "",
  given_name: null,
  surname: null,
  nicknames: [],
  emails: [],
  phones: [],
  organizations: [],
  titles: [],
  addresses: [],
  birthday: null,
  notes: "",
  notes_truncated: false,
  address_book_ids: [book],
  updated: "2026-11-26T09:00:00Z",
});

/** The given fields replace the stored ones; the rest stays. A given name part rebuilds the name. */
function applyContactFields(contact: ContactDetail, f: Omit<UpdateContactInputT, "contact_id">): ContactDetail {
  const next = { ...contact };
  if (f.name !== undefined || f.given_name !== undefined || f.surname !== undefined) {
    next.given_name = f.given_name ?? null;
    next.surname = f.surname ?? null;
    next.name = f.name ?? [f.given_name, f.surname].filter((v) => v !== undefined).join(" ");
  }
  if (f.emails !== undefined) next.emails = f.emails.map((e) => ({ address: e.address, label: e.label ?? null }));
  if (f.phones !== undefined) next.phones = f.phones.map((p) => ({ number: p.number, label: p.label ?? null }));
  if (f.organization !== undefined) {
    next.organizations = f.organization === "" ? [] : [{ name: f.organization, units: [] }];
  }
  if (f.job_title !== undefined) next.titles = f.job_title === "" ? [] : [f.job_title];
  if (f.notes !== undefined) next.notes = f.notes;
  if (f.birthday !== undefined) next.birthday = f.birthday;
  return next;
}

function seedAccount(key: AccountKey): Account {
  const p = key.toLowerCase();
  const calendarId = `${p}-cal-1`;
  return {
    accountId: `acct-${p}`,
    email: `${p}@test.example`,
    folders: [folder(`${p}-inbox`, "Inbox", "inbox"), folder(`${p}-drafts`, "Drafts", "drafts")],
    messages: [
      {
        id: `${p}-msg-1`,
        threadId: `${p}-thread-1`,
        folderId: `${p}-inbox`,
        subject: `Hello ${key}`,
        body: `First message of ${key}`,
        date: "2026-11-20T10:00:00Z",
      },
    ],
    contacts: [
      {
        id: `${p}-contact-1`,
        kind: "individual",
        name: `Contact of ${key}`,
        given_name: "Contact",
        surname: `of ${key}`,
        nicknames: [],
        emails: [{ address: `contact.${p}@elsewhere.example`, label: "work" }],
        phones: [],
        organizations: [{ name: "Example Org", units: [] }],
        titles: [],
        addresses: [],
        birthday: null,
        notes: "",
        notes_truncated: false,
        address_book_ids: [`${p}-book-1`],
        updated: "2026-11-20T09:00:00Z",
      },
    ],
    // One calendar and one event each; the search below behaves like the adapter's contract:
    // overlap with the window, earliest first, an unknown calendar is an empty page.
    calendars: [
      { id: calendarId, name: `Calendar ${key}`, description: null, color: null, is_default: true, time_zone: null, can_write: true },
    ],
    events: [
      {
        id: `${p}-event-1`,
        calendar_ids: [calendarId],
        title: `Meeting of ${key}`,
        start: "2026-11-27T09:00:00Z",
        end: "2026-11-27T10:00:00Z",
        local_start: "2026-11-27T10:00:00",
        time_zone: "Europe/Berlin",
        all_day: false,
        location: null,
        status: "confirmed",
        recurring: false,
        series_id: null,
        description: "",
        description_truncated: false,
        locations: [],
        online_meetings: [],
        participants: [],
        participants_omitted: 0,
        recurrence: null,
        free_busy: null,
        privacy: null,
      },
    ],
  };
}

export function createFakeMailStore() {
  const accounts: Record<AccountKey, Account> = { A: seedAccount("A"), B: seedAccount("B") };
  const calls: FakeCall[] = [];
  let nextFailure: unknown;
  let counter = 0;

  const ids = (key: AccountKey): FakeIds => {
    const a = accounts[key];
    const m = a.messages[0]!;
    return {
      accountId: a.accountId,
      email: a.email,
      folderId: a.folders[0]!.id,
      messageId: m.id,
      threadId: m.threadId,
      contactId: a.contacts[0]!.id,
      addressBookId: a.contacts[0]!.address_book_ids[0]!,
      calendarId: a.calendars[0]!.id,
      eventId: a.events[0]!.id,
    };
  };

  const summary = (m: StoredMessage, owner: Account): MailSummary => ({
    id: m.id,
    thread_id: m.threadId,
    folder_ids: [m.folderId],
    from: [{ name: "Sender", email: "sender@test.example" }],
    to: [{ name: null, email: owner.email }],
    subject: m.subject,
    date: m.date,
    preview: m.body.slice(0, 200),
    unread: false,
    flagged: false,
    answered: false,
    draft: false,
    has_attachment: false,
  });

  const threadMessage = (m: StoredMessage, owner: Account): ThreadMessage => ({
    id: m.id,
    from: [{ name: "Sender", email: "sender@test.example" }],
    to: [{ name: null, email: owner.email }],
    cc: [],
    date: m.date,
    subject: m.subject,
    body: m.body,
    body_truncated: false,
    attachments: [],
  });

  function mailboxFor(accountId: string): Mailbox {
    const account = Object.values(accounts).find((a) => a.accountId === accountId);
    if (account === undefined) throw new Error("unknown fake account");

    const record = (method: keyof Mailbox): void => {
      calls.push({ accountId, method });
      if (nextFailure !== undefined) {
        const failure = nextFailure;
        nextFailure = undefined;
        throw failure;
      }
    };
    const assertOwnMessage = (id: string | undefined): void => {
      if (id !== undefined && !account.messages.some((m) => m.id === id)) throw new MailError("not_found");
    };

    return {
      async listMailboxes() {
        record("listMailboxes");
        return { folders: account.folders };
      },
      async searchMail(input) {
        record("searchMail");
        const hits = account.messages
          .filter((m) => input.folder_id === undefined || m.folderId === input.folder_id)
          .sort((x, y) => y.date.localeCompare(x.date));
        const page = hits.slice(input.offset, input.offset + input.limit);
        const next = input.offset + page.length;
        return { messages: page.map((m) => summary(m, account)), next_offset: next < hits.length ? next : null };
      },
      async readThread(input) {
        record("readThread");
        const messages = account.messages.filter((m) => m.threadId === input.thread_id);
        if (messages.length === 0) throw new MailError("not_found");
        return { thread_id: input.thread_id, messages: messages.map((m) => threadMessage(m, account)), omitted_messages: 0 };
      },
      async createDraft(input: OutgoingMessage) {
        record("createDraft");
        assertOwnMessage(input.in_reply_to);
        counter += 1;
        return { draft_id: `${account.accountId}-draft-${counter}`, folder_id: account.folders[1]!.id };
      },
      async moveMail(input) {
        record("moveMail");
        const toTrash = "role" in input.target;
        const folderId = "role" in input.target ? `${account.accountId}-trash` : input.target.folder_id;
        if (!toTrash && !account.folders.some((f) => f.id === folderId)) throw new MailError("not_found");
        const notFound: string[] = [];
        let moved = 0;
        for (const id of new Set(input.message_ids)) {
          const message = account.messages.find((m) => m.id === id);
          if (message === undefined) {
            notFound.push(id);
            continue;
          }
          message.folderId = folderId;
          moved += 1;
        }
        if (moved === 0) throw new MailError("not_found");
        return { folder_id: folderId, moved, not_moved: notFound };
      },
      async sendMail(input: OutgoingMessage) {
        record("sendMail");
        assertOwnMessage(input.in_reply_to);
        counter += 1;
        return {
          message_id: `${account.accountId}-sent-${counter}`,
          recipients: input.to.length + input.cc.length + input.bcc.length,
          deduplicated: false,
        };
      },
      async searchContacts(input) {
        record("searchContacts");
        // An address book of the other account matches nothing here.
        const needle = (v: string | undefined) => (v === undefined ? () => true : (t: string) => t.toLowerCase().includes(v.toLowerCase()));
        const text = needle(input.text);
        const hits = account.contacts
          .filter((c) => input.address_book_id === undefined || c.address_book_ids.includes(input.address_book_id))
          .filter((c) => text(c.name) || c.emails.some((e) => text(e.address)))
          .filter((c) => needle(input.name)(c.name))
          .filter((c) => input.email === undefined || c.emails.some((e) => needle(input.email)(e.address)))
          .sort((x, y) => (y.updated ?? "").localeCompare(x.updated ?? ""));
        const page = hits.slice(input.offset, input.offset + input.limit);
        const next = input.offset + page.length;
        return { contacts: page.map(summaryOfContact), next_offset: next < hits.length ? next : null };
      },
      async readContact(input) {
        record("readContact");
        const contact = account.contacts.find((c) => c.id === input.contact_id);
        if (contact === undefined) throw new MailError("not_found");
        return { contact };
      },
      async listCalendars() {
        record("listCalendars");
        return { calendars: account.calendars };
      },
      async searchEvents(input) {
        record("searchEvents");
        const needle = input.text?.toLowerCase();
        const hits = account.events
          .filter((e) => input.calendar_id === undefined || e.calendar_ids.includes(input.calendar_id))
          .filter((e) => needle === undefined || `${e.title} ${e.description} ${e.location ?? ""}`.toLowerCase().includes(needle))
          .filter(
            (e) =>
              e.start !== null &&
              Date.parse(e.start) < Date.parse(input.before) &&
              Date.parse(e.end ?? e.start) > Date.parse(input.after),
          )
          .sort((x, y) => Date.parse(x.start ?? "") - Date.parse(y.start ?? ""));
        const page = hits.slice(input.offset, input.offset + input.limit);
        const next = input.offset + page.length;
        return { events: page.map(summaryOfEvent), next_offset: next < hits.length ? next : null };
      },
      async readEvent(input) {
        record("readEvent");
        const event = account.events.find((e) => e.id === input.event_id);
        if (event === undefined) throw new MailError("not_found");
        return { event };
      },
      async createContact(input) {
        record("createContact");
        // Each account has one address book, `<a|b>-book-1`; another account's book is not found.
        const ownBook = `${accountId.slice("acct-".length)}-book-1`;
        const book = input.address_book_id ?? ownBook;
        if (book !== ownBook) throw new MailError("not_found");
        counter += 1;
        const id = `${accountId}-contact-x${counter}`;
        const { address_book_id: _book, ...fields } = input;
        account.contacts.push(applyContactFields(emptyContact(id, book), fields));
        return { contact_id: id, address_book_id: book };
      },
      async updateContact(input) {
        record("updateContact");
        const index = account.contacts.findIndex((c) => c.id === input.contact_id);
        if (index < 0) throw new MailError("not_found");
        const { contact_id: _id, ...fields } = input;
        account.contacts[index] = applyContactFields(account.contacts[index]!, fields);
        return { contact_id: input.contact_id };
      },
      async deleteContact(input) {
        record("deleteContact");
        const ids = [...new Set(input.contact_ids)];
        const gone = ids.filter((id) => account.contacts.some((c) => c.id === id));
        if (gone.length === 0) throw new MailError("not_found");
        account.contacts = account.contacts.filter((c) => !gone.includes(c.id));
        return { deleted: gone.length, not_deleted: ids.filter((id) => !gone.includes(id)) };
      },
      // The event writes keep it simple: the title, location, description and participants are
      // stored as given, the time is not computed. Every participant counts as notified (the
      // vault's decision about past events and limits is tested against the vault, not here).
      async createEvent(input) {
        record("createEvent");
        const calendar = input.calendar_id ?? account.calendars[0]!.id;
        if (!account.calendars.some((c) => c.id === calendar)) throw new MailError("not_found");
        counter += 1;
        const id = `${accountId}-event-x${counter}`;
        const base = account.events[0]!;
        const participants = (input.participants ?? []).map((p) => ({ name: p.name ?? null, email: p.email, role: "attendee", status: "needs-action" }));
        account.events.push({
          ...base,
          id,
          calendar_ids: [calendar],
          title: input.title ?? "",
          location: input.location ?? null,
          description: input.description ?? "",
          participants,
        });
        return { event_id: id, calendar_id: calendar, invitations: participants.length, deduplicated: false };
      },
      async updateEvent(input) {
        record("updateEvent");
        const event = account.events.find((e) => e.id === input.event_id);
        if (event === undefined) throw new MailError("not_found");
        if (input.calendar_id !== undefined && !account.calendars.some((c) => c.id === input.calendar_id)) {
          throw new MailError("not_found");
        }
        const before = event.participants.map((p) => p.email ?? "");
        if (input.title !== undefined) event.title = input.title;
        if (input.location !== undefined) event.location = input.location === "" ? null : input.location;
        if (input.description !== undefined) event.description = input.description;
        if (input.calendar_id !== undefined) event.calendar_ids = [input.calendar_id];
        if (input.participants !== undefined) {
          event.participants = input.participants.map((p) => ({ name: p.name ?? null, email: p.email, role: "attendee", status: "needs-action" }));
        }
        const involved = new Set([...before, ...event.participants.map((p) => p.email ?? "")].filter((a) => a !== ""));
        return { event_id: input.event_id, invitations: involved.size, deduplicated: false };
      },
      async deleteEvent(input) {
        record("deleteEvent");
        const ids = [...new Set(input.event_ids)];
        const gone = account.events.filter((e) => ids.includes(e.id));
        if (gone.length === 0) throw new MailError("not_found");
        account.events = account.events.filter((e) => !gone.includes(e));
        const notifying = gone.filter((e) => e.participants.length > 0);
        return {
          deleted: gone.length,
          not_deleted: ids.filter((id) => !gone.some((e) => e.id === id)),
          cancellations: notifying.length,
          cancelled_attendees: notifying.reduce((n, e) => n + e.participants.length, 0),
        };
      },
    };
  }

  return {
    calls,
    get a(): FakeIds {
      return ids("A");
    },
    get b(): FakeIds {
      return ids("B");
    },
    mailboxFor,
    /** Adds a message in its own thread to the inbox of `key`; returns its ids. */
    addMessage(key: AccountKey, m: { subject: string; body: string }): { messageId: string; threadId: string } {
      const a = accounts[key];
      counter += 1;
      const stored: StoredMessage = {
        id: `${a.accountId}-msg-x${counter}`,
        threadId: `${a.accountId}-thread-x${counter}`,
        folderId: a.folders[0]!.id,
        subject: m.subject,
        body: m.body,
        date: "2026-11-24T10:00:00Z",
      };
      a.messages.push(stored);
      return { messageId: stored.id, threadId: stored.threadId };
    },
    /** The next mailbox call throws `error` instead of answering. */
    failNextWith(error: unknown): void {
      nextFailure = error;
    },
  };
}

export type FakeMailStore = ReturnType<typeof createFakeMailStore>;
