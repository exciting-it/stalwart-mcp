import type { Area } from "../config";
import { createDraft } from "./create-draft";
import { deleteMail } from "./delete-mail";
import type { Tool } from "./define-tool";
import { listCalendars } from "./list-calendars";
import { listMailboxes } from "./list-mailboxes";
import { moveMail } from "./move-mail";
import { readContact } from "./read-contact";
import { readEvent } from "./read-event";
import { readThread } from "./read-thread";
import { searchContacts } from "./search-contacts";
import { searchEvents } from "./search-events";
import { searchMail } from "./search-mail";
import { sendMail } from "./send-mail";

export const TOOLS: Tool[] = [listMailboxes, searchMail, readThread, createDraft, sendMail, moveMail, deleteMail, searchContacts, readContact, listCalendars, searchEvents, readEvent];

/** The tools a deployment offers: every mail tool, and those of the areas it has switched on. */
export function toolsFor(areas: ReadonlySet<Area>): Tool[] {
  return TOOLS.filter((tool) => tool.spec.area === undefined || areas.has(tool.spec.area));
}
