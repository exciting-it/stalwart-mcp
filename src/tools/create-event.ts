import { CreateEventInput, CreateEventResult } from "../collab";
import { defineTool } from "./define-tool";

export const createEvent = defineTool({
  name: "create_event",
  title: "Create event",
  description:
    "Create an event in the calendar of the connected mailbox: a title, either a time (start and end, with an optional IANA time_zone, default UTC) or whole days (date and days), location, description, participants and a recurrence rule. Without calendar_id the event goes into the default calendar. With participants (at most 10) the mail server sends them invitations by email from the mailbox's address, and later changes and the deletion send updates and cancellations to them; each such write counts as one of the mailbox's 50 sent messages per day. The same create with participants repeated within 10 minutes returns the first event (deduplicated: true) and sends nothing. If the call fails because the mail server is temporarily unavailable, check with search_events before creating the event again: it may exist already. Confirm participants and times with the user first.",
  kind: "notify",
  area: "calendars",
  input: CreateEventInput,
  output: CreateEventResult,
  run: (mailbox, input) => mailbox.createEvent(input),
  count: () => 1,
  // A deduplicated answer describes the first event; this call made the server notify nobody.
  recipients: (result) => (result.deduplicated ? 0 : result.invitations),
});
