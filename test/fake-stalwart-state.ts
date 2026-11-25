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

export interface FakeAccount {
  accountId: string;
  email: string;
  folders: Map<string, FakeFolder>;
  emails: Map<string, FakeEmail>;
  identities: FakeIdentity[];
  sent: SentMessage[];
}

/** What the JMAP handlers need from the fake. */
export interface FakeState {
  nextId(prefix: string): string;
  nextReceivedAt(): string;
  /** True (and consumed) when a test asked for the next submission to be rejected. */
  takeSubmissionRejection(): boolean;
}
