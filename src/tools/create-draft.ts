import { CreateDraftInput, CreateDraftResult, OUTGOING_CONTENT_NOTE } from "../mail";
import { defineTool } from "./define-tool";

export const createDraft = defineTool({
  name: "create_draft",
  title: "Create draft",
  description: `Save a new message or a reply as a draft in the connected mailbox. Nothing is sent. ${OUTGOING_CONTENT_NOTE}`,
  kind: "draft",
  input: CreateDraftInput,
  output: CreateDraftResult,
  run: (mailbox, input) => mailbox.createDraft(input),
});
