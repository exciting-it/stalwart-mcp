/**
 * What the bytes of an attachment are delivered as. The bytes decide, not what the sender
 * declared: an image signature makes an image, a text type that decodes in its charset makes
 * text, everything else is a file. Pure functions; they run in the mailbox vault, where the CPU
 * for decoding, cleaning and base64 is spent, never in the Worker that answers the request.
 */
import { MAIL_LIMITS } from "../mail";
import { cleanText, htmlToText } from "./sanitize";

export type AttachmentKind = "text" | "image" | "file";

/** The part of a delivery that depends on the bytes; ids and name are the caller's. */
export interface AttachmentContent {
  kind: AttachmentKind;
  type: string;
  size: number;
  text: string | null;
  total_chars: number | null;
  next_offset: number | null;
  text_truncated: boolean;
  /** The bytes as base64 for an image or a file; null for text. */
  data: string | null;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const PDF = ascii("%PDF-");

/** The image type of the bytes' signature (PNG, JPEG, GIF, WebP), or null. */
export function imageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "image/gif";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return null;
}

const PLAIN_MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;

/** The declared type lower-cased when it is a plain media type, else null. */
function plainType(declared: string): string | null {
  const type = declared.trim().toLowerCase();
  return PLAIN_MEDIA_TYPE.test(type) ? type : null;
}

/** `text/*`, JSON, XML and the `+json` / `+xml` types are read as text. */
function isTextType(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

/** The charsets a text attachment may declare; anything else (or none) is read as UTF-8. */
const CHARSETS: Record<string, string> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  "us-ascii": "us-ascii",
  "iso-8859-1": "iso-8859-1",
  latin1: "iso-8859-1",
  "windows-1252": "windows-1252",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
};

/**
 * The bytes as text in `charset`, strictly: a byte sequence that is not valid there is null.
 * ISO-8859-1 is decoded as the WHATWG Encoding Standard does, as windows-1252.
 */
function decodeStrict(bytes: Uint8Array, charset: string | null): string | null {
  const label = CHARSETS[(charset ?? "").trim().toLowerCase()] ?? "utf-8";
  try {
    if (label === "us-ascii") {
      if (bytes.some((b) => b > 0x7f)) return null;
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    }
    return new TextDecoder(label, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** One page of `text` from `offset`, at most `maxChars` long, never splitting a surrogate pair. */
export function page(text: string, offset: number, maxChars: number): { text: string; next_offset: number | null } {
  if (offset >= text.length) return { text: "", next_offset: null };
  let start = offset;
  // An offset inside a pair (only possible when chosen by hand) skips its second half.
  if (start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start += 1;
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length && end - 1 > start && isHigh(text.charCodeAt(end - 1))) end -= 1;
  return { text: text.slice(start, end), next_offset: end < text.length ? end : null };
}

/** Base64 of the bytes, built in chunks so no argument list grows with the file. */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

/**
 * Decides what `bytes` are delivered as. `declared` is the server's `type` and `charset` of the
 * part (written by the sender); `offset` and `maxChars` page through a text file.
 */
export function attachmentContent(
  bytes: Uint8Array,
  declared: { type: string; charset: string | null },
  offset: number,
  maxChars: number,
): AttachmentContent {
  const binary = (kind: "image" | "file", type: string): AttachmentContent => ({
    kind,
    type,
    size: bytes.length,
    text: null,
    total_chars: null,
    next_offset: null,
    text_truncated: false,
    data: toBase64(bytes),
  });

  const image = imageType(bytes);
  if (image !== null) return binary("image", image);

  const type = plainType(declared.type);
  if (type !== null && isTextType(type)) {
    const decoded = decodeStrict(bytes, declared.charset);
    if (decoded !== null) {
      const raw = type === "text/html" ? htmlToText(decoded) : decoded;
      const cleaned = cleanText(raw, MAIL_LIMITS.attachmentTextChars);
      const shown = page(cleaned.text, offset, maxChars);
      return {
        kind: "text",
        type,
        size: bytes.length,
        text: shown.text,
        total_chars: cleaned.text.length,
        next_offset: shown.next_offset,
        text_truncated: cleaned.truncated,
        data: null,
      };
    }
  }

  if (startsWith(bytes, PDF)) return binary("file", "application/pdf");
  return binary("file", type ?? "application/octet-stream");
}
