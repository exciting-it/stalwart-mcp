import { DeleteMailInput, MoveMailResult } from "../mail";
import { defineTool } from "./define-tool";

export const deleteMail = defineTool({
  name: "delete_mail",
  title: "Delete mail",
  description:
    "Move messages of the connected mailbox to its Trash folder. This connector never empties the Trash, and move_mail can bring a message back; the mail server itself may clear old Trash on its own schedule. At most 50 messages per call. Confirm with the user first.",
  kind: "trash",
  input: DeleteMailInput,
  output: MoveMailResult,
  // The target is fixed here: no input can turn this into a move elsewhere or a real deletion.
  run: (mailbox, input) => mailbox.moveMail({ message_ids: input.message_ids, target: { role: "trash" } }),
  count: (result) => result.moved,
});
