/**
 * The fake Stalwart's shared state types: what `fake-stalwart.ts` keeps and the JMAP handlers in
 * `fake-stalwart-jmap.ts` read and change. A leaf module, so the two never import each other.
 */
export interface FakeAddress {
  name: string | null;
  email: string;
}

export interface FakeFolder {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
}

export interface FakeIdentity {
  id: string;
  name: string;
  email: string;
}

export interface FakeAttachment {
  blobId: string;
  name: string | null;
  size: number;
  type: string;
}

export interface FakeEmail {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
  from: FakeAddress[];
  to: FakeAddress[];
  cc: FakeAddress[];
  bcc: FakeAddress[];
  subject: string;
  receivedAt: string;
  messageId: string[];
  inReplyTo: string[] | null;
  references: string[] | null;
  text: string | null;
  html: string | null;
  preview: string;
  attachments: FakeAttachment[];
}

/** One message accepted by `EmailSubmission/set`, as the fake saw it at submission time. */
export interface SentMessage {
  submissionId: string;
  emailId: string;
  identityId: string;
  from: FakeAddress[];
  to: FakeAddress[];
  cc: FakeAddress[];
  bcc: FakeAddress[];
  subject: string;
  text: string | null;
  inReplyTo: string[] | null;
  references: string[] | null;
}

export interface FakeAddressBook {
  id: string;
  name: string;
  isDefault: boolean;
}

/** A ContactCard as the fake stores it: a JSContact Card (RFC 9553) with `id` and `addressBookIds`. */
export type FakeContact = Record<string, unknown> & {
  id: string;
  addressBookIds: Record<string, true>;
  updated: string;
};

export interface FakeCalendar {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  isDefault: boolean;
  timeZone: string | null;
  mayWrite: boolean;
}

/**
 * A CalendarEvent as the fake stores it: a JSCalendar Event (RFC 8984) with `id` and `calendarIds`.
 * `start` is a LocalDateTime in `timeZone` (null: UTC), `duration` an ISO 8601 duration.
 */
export type FakeEvent = Record<string, unknown> & {
  id: string;
  calendarIds: Record<string, true>;
  start: string;
  duration: string;
};

/**
 * One iTIP message the fake "sent" for a `CalendarEvent/set` with `sendSchedulingMessages: true`:
 * an invitation or update (`REQUEST`) or a cancellation (`CANCEL`), with the attendees it went to.
 */
export interface SchedulingMessage {
  kind: "REQUEST" | "CANCEL";
  eventId: string;
  attendees: string[];
}

export interface FakeAccount {
  accountId: string;
  email: string;
  folders: Map<string, FakeFolder>;
  emails: Map<string, FakeEmail>;
  identities: FakeIdentity[];
  sent: SentMessage[];
  addressBooks: Map<string, FakeAddressBook>;
  contacts: Map<string, FakeContact>;
  calendars: Map<string, FakeCalendar>;
  events: Map<string, FakeEvent>;
  scheduling: SchedulingMessage[];
}

/** What the JMAP handlers need from the fake. */
export interface FakeState {
  nextId(prefix: string): string;
  nextReceivedAt(): string;
  /** True (and consumed) when a test asked for the next submission to be rejected. */
  takeSubmissionRejection(): boolean;
}
