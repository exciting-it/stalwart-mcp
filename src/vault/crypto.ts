/** AES-GCM encryption of Stalwart tokens at rest (WebCrypto). The key is the TOKEN_ENC_KEY secret. */

const KEY_ERROR = "TOKEN_ENC_KEY must be 32 bytes, base64 encoded.";
const IV_BYTES = 12;

export interface SecretBox {
  iv: string;
  ct: string;
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(keyB64);
  } catch {
    throw new Error(KEY_ERROR);
  }
  if (raw.length !== 32) throw new Error(KEY_ERROR);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(keyB64: string, plaintext: string, aad: string): Promise<SecretBox> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

export async function decryptSecret(keyB64: string, box: SecretBox, aad: string): Promise<string> {
  const key = await importKey(keyB64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(box.iv), additionalData: new TextEncoder().encode(aad) },
    key,
    fromBase64(box.ct),
  );
  return new TextDecoder().decode(plain);
}
