import { createDraft } from "./create-draft";
import { deleteMail } from "./delete-mail";
import type { Tool } from "./define-tool";
import { listMailboxes } from "./list-mailboxes";
import { moveMail } from "./move-mail";
import { readThread } from "./read-thread";
import { searchMail } from "./search-mail";
import { sendMail } from "./send-mail";

export const TOOLS: Tool[] = [listMailboxes, searchMail, readThread, createDraft, sendMail, moveMail, deleteMail];
