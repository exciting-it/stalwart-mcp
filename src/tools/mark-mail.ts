import { MarkMailInput, MarkMailResult } from "../mail";
import { defineTool } from "./define-tool";

export const markMail = defineTool({
  name: "mark_mail",
  title: "Mark mail",
  description:
    "Set or clear read and flagged on messages of the connected mailbox: message ids from search_mail or read_thread. read: true marks them read, false unread; flagged: true flags them, false removes the flag; give at least one of the two. Nothing else of a message changes: it stays in its folders and keeps its other marks. At most 50 messages per call.",
  kind: "mark",
  input: MarkMailInput,
  output: MarkMailResult,
  run: (mailbox, input) => mailbox.markMail(input),
  count: (result) => result.marked,
});
