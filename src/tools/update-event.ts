import { UpdateEventInput, UpdateEventResult } from "../collab";
import { defineTool } from "./define-tool";

export const updateEvent = defineTool({
  name: "update_event",
  title: "Update event",
  description:
    "Change one event of the connected mailbox by its id. A field that is given replaces the stored one; fields that are not given stay as they are. participants replaces the whole list of attendees (an empty list removes them all), recurrence replaces the rule (null removes it), an empty location removes it. An occurrence id (as search_events lists it for a recurring event) changes that occurrence only. When the event has participants before or after the change, the mail server sends them updates by email (an invitation to added ones, a cancellation to removed ones); each such write counts as one of the mailbox's 50 sent messages per day. At most 10 participants. Confirm participants and times with the user first.",
  kind: "notify",
  area: "calendars",
  input: UpdateEventInput,
  output: UpdateEventResult,
  run: (mailbox, input) => mailbox.updateEvent(input),
  count: () => 1,
  recipients: (result) => result.invitations,
});
