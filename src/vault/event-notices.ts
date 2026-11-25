/**
 * Whether an event write makes the mail server notify people, and whom: the decision the vault
 * takes before it counts, checks and deduplicates the write like a send (docs/design.md).
 *
 * The server sends nothing for an event without attendees or one that ends in the past. "Ends in
 * the past" is judged here as simply as is safe: a recurring event (or an occurrence of one) never
 * ends in the past, a floating or all-day end gets a day to spare, and an unknown end is not past.
 * When unsure, the write counts as notifying: it costs a send it may not need, never the reverse.
 *
 * A meeting someone else organized (`organizedByMailbox` false) is never notified about: a change
 * or deletion only affects the mailbox's own copy, and is written without scheduling messages.
 *
 * One counted send covers at most `eventParticipantsMax` addresses, like one sent message: a write
 * that involves more (an existing event created elsewhere) counts one send per started ten.
 */
import { COLLAB_LIMITS, type CreateEventInputT, type EventAudience, type UpdateEventInputT } from "../collab";

const DAY_MS = 86_400_000;

/** Whom a write notifies (lower-cased, each once) and whether it notifies at all. */
export interface Notice {
  addresses: string[];
  notify: boolean;
}

/** The sends a notifying write of `notice` counts: one per started `eventParticipantsMax` addresses. */
export function sendsFor(notice: Notice): number {
  return Math.max(1, Math.ceil(notice.addresses.length / COLLAB_LIMITS.eventParticipantsMax));
}

type EventTime = Pick<CreateEventInputT, "end" | "date" | "days">;

/** The latest instant the input's time can end at, or null when the input gives no time. */
function inputEnd(t: EventTime): number | null {
  if (t.end !== undefined) return Date.parse(t.end);
  if (t.date === undefined) return null;
  const [year, month, day] = t.date.split("-").map(Number) as [number, number, number];
  // Floating: the day ends at different instants around the world; a day to spare.
  return Date.UTC(year, month - 1, day) + ((t.days ?? 1) + 1) * DAY_MS;
}

const endsInPast = (end: number | null, now: number): boolean => end !== null && end < now;

const lowerUnique = (list: string[]): string[] => [...new Set(list.map((a) => a.toLowerCase()))];

/** A create notifies its participants, unless it ends in the past. */
export function createNotice(input: CreateEventInputT, now: number): Notice {
  const addresses = lowerUnique((input.participants ?? []).map((p) => p.email));
  const recurring = input.recurrence !== undefined;
  return { addresses, notify: addresses.length > 0 && (recurring || !endsInPast(inputEnd(input), now)) };
}

/**
 * An update notifies the attendees before and after it (added ones get the invitation, removed
 * ones a cancellation, the others an update), unless the event ends in the past afterwards or
 * someone else organizes it.
 */
export function updateNotice(input: UpdateEventInputT, before: EventAudience, now: number): Notice {
  const after = input.participants === undefined ? before.attendees : input.participants.map((p) => p.email);
  const addresses = lowerUnique([...before.attendees, ...after]);
  const recurring = input.recurrence !== undefined ? input.recurrence !== null : before.recurring;
  const end = recurring ? null : (inputEnd(input) ?? before.end);
  return { addresses, notify: before.organizedByMailbox && addresses.length > 0 && !endsInPast(end, now) };
}

/** A deletion cancels the event for its attendees, unless it ended in the past or someone else organizes it. */
export function deleteNotice(audience: EventAudience, now: number): Notice {
  const end = audience.recurring ? null : audience.end;
  return {
    addresses: audience.attendees,
    notify: audience.organizedByMailbox && audience.attendees.length > 0 && !endsInPast(end, now),
  };
}
