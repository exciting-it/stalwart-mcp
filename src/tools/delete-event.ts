import { DeleteEventInput, DeleteEventResult } from "../collab";
import { defineTool } from "./define-tool";

export const deleteEvent = defineTool({
  name: "delete_event",
  title: "Delete event",
  description:
    "Delete events of the connected mailbox by their ids, up to 50 per call. The events are removed for good and cannot be brought back; there is no trash for events. An occurrence id (as search_events lists it for a recurring event) deletes that occurrence only; the rest of the series stays. The participants of a deleted event that has not ended get a cancellation by email from the mail server; each such event counts as one of the mailbox's 50 sent messages per day, and when fewer are left nothing is deleted. Ids that are not events of this mailbox are listed in not_deleted. Confirm participants and times with the user first.",
  kind: "destroy_notify",
  area: "calendars",
  input: DeleteEventInput,
  output: DeleteEventResult,
  run: (mailbox, input) => mailbox.deleteEvent(input),
  count: (result) => result.deleted,
  recipients: (result) => result.cancelled_attendees,
});
