import { CreateContactInput, CreateContactResult } from "../collab";
import { defineTool } from "./define-tool";

export const createContact = defineTool({
  name: "create_contact",
  title: "Create contact",
  description:
    "Create a contact in the address book of the connected mailbox: names, up to 10 email addresses and 10 phone numbers, organization, job title, notes and birthday. At least a name, an organization or an email address is required. Without address_book_id the contact goes into the default address book. If the call fails because the mail server is temporarily unavailable, check with search_contacts before creating the contact again: it may exist already. Confirm with the user first.",
  kind: "create",
  area: "contacts",
  input: CreateContactInput,
  output: CreateContactResult,
  run: (mailbox, input) => mailbox.createContact(input),
  count: () => 1,
});
