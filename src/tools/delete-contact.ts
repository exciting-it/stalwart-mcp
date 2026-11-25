import { DeleteContactInput, DeleteResult } from "../collab";
import { defineTool } from "./define-tool";

export const deleteContact = defineTool({
  name: "delete_contact",
  title: "Delete contact",
  description:
    "Delete contacts of the connected mailbox by their ids, up to 50 per call. The contacts are removed for good and cannot be brought back; there is no trash for contacts. Ids that are not contacts of this mailbox are listed in not_deleted. Confirm with the user first.",
  kind: "destroy",
  area: "contacts",
  input: DeleteContactInput,
  output: DeleteResult,
  run: (mailbox, input) => mailbox.deleteContact(input),
  count: (result) => result.deleted,
});
