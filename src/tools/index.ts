import type { Area } from "../config";
import { createContact } from "./create-contact";
import { createDraft } from "./create-draft";
import { createEvent } from "./create-event";
import { deleteContact } from "./delete-contact";
import { deleteEvent } from "./delete-event";
import { deleteMail } from "./delete-mail";
import type { Tool } from "./define-tool";
import { listCalendars } from "./list-calendars";
import { listMailboxes } from "./list-mailboxes";
import { markMail } from "./mark-mail";
import { moveMail } from "./move-mail";
import { readContact } from "./read-contact";
import { readEvent } from "./read-event";
import { readThread } from "./read-thread";
import { respondToEvent } from "./respond-to-event";
import { searchContacts } from "./search-contacts";
import { searchEvents } from "./search-events";
import { searchMail } from "./search-mail";
import { sendMail } from "./send-mail";
import { updateContact } from "./update-contact";
import { updateEvent } from "./update-event";

export const TOOLS: Tool[] = [listMailboxes, searchMail, readThread, createDraft, sendMail, moveMail, deleteMail, markMail, searchContacts, readContact, listCalendars, searchEvents, readEvent, createContact, updateContact, deleteContact, createEvent, updateEvent, respondToEvent, deleteEvent];

/** The tools a deployment offers: every mail tool, and those of the areas it has switched on. */
export function toolsFor(areas: ReadonlySet<Area>): Tool[] {
  return TOOLS.filter((tool) => tool.spec.area === undefined || areas.has(tool.spec.area));
}
