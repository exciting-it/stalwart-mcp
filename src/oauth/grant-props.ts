/**
 * What a Worker grant must carry for `/mcp` to accept it. The callback checks the same schemas
 * before it creates anything, so no grant can exist that the MCP endpoint would refuse forever.
 */
import { EmailAddressSchema, MailIdSchema } from "../mail";
import { z } from "zod";

/** The grant's props: exactly the mailbox's account id and address. */
export const GrantProps = z.object({ accountId: MailIdSchema, email: EmailAddressSchema });

/** The AI tool's client id as the OAuth layer reports it. */
export const GrantClientId = z.string().min(1).max(255);
