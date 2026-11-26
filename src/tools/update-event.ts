import { UpdateEventInput, UpdateEventResult } from "../collab";
import { defineTool } from "./define-tool";

export const updateEvent = defineTool({
  name: "update_event",
  title: "Update event",
  description:
    "Change one event of the connected mailbox by its id. A field that is given replaces the stored one; fields that are not given stay as they are. participants replaces the whole list of attendees (an empty list removes them all; attendees who stay keep their answers), recurrence replaces the rule (null removes it), an empty location removes it. A new start and end without time_zone stay in the event's own time zone (UTC for an event without one); time_zone is an IANA name such as Europe/Berlin. An occurrence id (as search_events lists it for a recurring event) changes that occurrence only; its series_id (from search_events or read_event) changes the whole series. Unless the event has already ended, the mail server sends its participants before and after the change an update by email (an invitation to added ones, a cancellation to removed ones); each such write counts as one of the mailbox's 50 sent messages per day, and an identical change repeated within 10 minutes is not sent again (deduplicated: true). At most 10 participants. For a meeting someone else organized, a change only affects your own copy: the organizer is not informed, and participants and recurrence cannot be changed. Confirm participants and times with the user first.",
  kind: "notify",
  area: "calendars",
  input: UpdateEventInput,
  output: UpdateEventResult,
  run: (mailbox, input) => mailbox.updateEvent(input),
  count: () => 1,
  // A deduplicated answer repeats the first one; this call made the server notify nobody.
  recipients: (result) => (result.deduplicated ? 0 : result.invitations),
});
