import { RespondToEventInput, RespondToEventResult } from "../collab";
import { defineTool } from "./define-tool";

export const respondToEvent = defineTool({
  name: "respond_to_event",
  title: "Respond to event",
  description:
    "Answer an invitation to a meeting someone else organized that lists the connected mailbox as a participant: response is accepted, declined or tentative. event_id comes from search_events or read_event; an occurrence id (as search_events lists it for a recurring event) answers that occurrence only, its series_id the whole series. Only the mailbox's own answer changes, nothing else of the event. Unless the event has already ended, the mail server sends the organizer the answer by email from the mailbox's address, which counts as one of the mailbox's 50 sent messages per day. An answer the event already has is not sent again (organizer_notified: false); two identical answers at the same time are sent once (deduplicated: true). Not for events the mailbox organizes or that do not list it. Ask the user first.",
  kind: "notify",
  area: "calendars",
  input: RespondToEventInput,
  output: RespondToEventResult,
  run: (mailbox, input) => mailbox.respondToEvent(input),
  count: () => 1,
  // A deduplicated answer repeats the first one; this call made the server notify nobody.
  recipients: (result) => (result.organizer_notified && !result.deduplicated ? 1 : 0),
});
