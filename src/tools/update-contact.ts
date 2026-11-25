import { UpdateContactInput, UpdateContactResult } from "../collab";
import { defineTool } from "./define-tool";

export const updateContact = defineTool({
  name: "update_contact",
  title: "Update contact",
  description:
    "Change one contact of the connected mailbox by its id. A field that is given replaces the stored one as a whole (for emails and phones that means the complete new list; an empty list removes them; an empty organization, job_title or notes removes it); fields that are not given stay as they are. name, given_name and surname together decide the name: when any of them is given, the name is rebuilt from the ones given, and the stored other parts are not kept. Confirm with the user first.",
  kind: "update",
  area: "contacts",
  input: UpdateContactInput,
  output: UpdateContactResult,
  run: (mailbox, input) => mailbox.updateContact(input),
  count: () => 1,
});
