import { MoveMailInput, MoveMailResult } from "../mail";
import { defineTool } from "./define-tool";

export const moveMail = defineTool({
  name: "move_mail",
  title: "Move mail",
  description:
    "Move messages of the connected mailbox into one of its folders: message ids from search_mail or read_thread, the folder id from list_mailboxes. A moved message leaves its other folders. The Trash folder is not accepted here: use delete_mail for that. At most 50 messages per call. Confirm with the user first.",
  kind: "move",
  input: MoveMailInput,
  output: MoveMailResult,
  run: (mailbox, input) => mailbox.moveMail({ message_ids: input.message_ids, target: { folder_id: input.folder_id } }),
  count: (result) => result.moved,
});
