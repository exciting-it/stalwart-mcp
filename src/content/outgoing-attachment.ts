/**
 * The attachments of an outgoing message (`send_mail`, `create_draft`), prepared in the mailbox
 * vault before the send fingerprint is taken and before the mailbox is touched: a text file is
 * encoded as UTF-8, a base64 file decoded and, for PDF and the image types, checked against its
 * signature; each gets a SHA-256 of its bytes. A file of a message of the mailbox stays a
 * reference: its lookup is the adapter's. This is the CPU-heavy part (decoding, hashing), which
 * runs in the vault, never in the Worker that answers the request.
 */
import { MAIL_LIMITS, MailError, type OutgoingAttachmentT, type PreparedAttachment } from "../mail";
import { hasSignatureOf } from "./attachment";

/** The bytes of standard base64 (already checked by the input schema); null when they cannot be decoded. */
function decodeBase64(value: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Each attachment, in the order given. A base64 file that does not decode, is larger than
 * `attachmentUploadBytes` or (PDF, images) does not start with its type's signature is
 * `invalid_input`.
 */
export async function prepareAttachments(attachments: readonly OutgoingAttachmentT[]): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const a of attachments) {
    if ("message_id" in a) {
      prepared.push({ message_id: a.message_id, attachment_id: a.attachment_id });
      continue;
    }
    let bytes: Uint8Array;
    let charset: "utf-8" | null;
    if ("text" in a) {
      bytes = new TextEncoder().encode(a.text);
      charset = "utf-8";
    } else {
      const decoded = decodeBase64(a.base64);
      if (decoded === null || decoded.length > MAIL_LIMITS.attachmentUploadBytes) throw new MailError("invalid_input");
      if (!hasSignatureOf(decoded, a.content_type)) throw new MailError("invalid_input");
      bytes = decoded;
      charset = null;
    }
    prepared.push({ name: a.filename, type: a.content_type, charset, bytes, sha256: await sha256Hex(bytes) });
  }
  return prepared;
}
