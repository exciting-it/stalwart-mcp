import { SendMailInput, SendMailResult } from "../mail";
import { defineTool } from "./define-tool";

export const sendMail = defineTool({
  name: "send_mail",
  title: "Send mail",
  description:
    "Send a plain-text message or reply from the connected mailbox's own address. At most 10 recipients per message and 50 messages per day. Confirm recipients and text with the user first.",
  kind: "send",
  input: SendMailInput,
  output: SendMailResult,
  run: (mailbox, input) => mailbox.sendMail(input),
});
