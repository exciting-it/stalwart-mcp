import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/vault/crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes
const KEY2 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // 32 bytes of 0x01

describe("token encryption", () => {
  it("round-trips and uses a fresh IV each time", async () => {
    const a = await encryptSecret(KEY, "refresh-token-value", "acct:1");
    const b = await encryptSecret(KEY, "refresh-token-value", "acct:1");
    expect(atob(a.iv)).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(a.ct).not.toContain("refresh-token-value");
    expect(await decryptSecret(KEY, a, "acct:1")).toBe("refresh-token-value");
    expect(await decryptSecret(KEY, b, "acct:1")).toBe("refresh-token-value");
  });

  it("fails to decrypt with another aad, another key or a changed ciphertext", async () => {
    const box = await encryptSecret(KEY, "secret", "acct:1");
    await expect(decryptSecret(KEY, box, "acct:2")).rejects.toThrow();
    await expect(decryptSecret(KEY2, box, "acct:1")).rejects.toThrow();
    const bytes = Uint8Array.from(atob(box.ct), (c) => c.charCodeAt(0));
    bytes[0] = bytes[0]! ^ 1;
    const changed = { iv: box.iv, ct: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptSecret(KEY, changed, "acct:1")).rejects.toThrow();
  });

  it.each(["", "short", "AAAA"])("refuses key %j without echoing it", async (k) => {
    await expect(encryptSecret(k, "x", "a")).rejects.toThrow("TOKEN_ENC_KEY must be 32 bytes, base64 encoded.");
    await expect(decryptSecret(k, { iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }, "a")).rejects.toThrow(
      "TOKEN_ENC_KEY must be 32 bytes, base64 encoded.",
    );
  });
});
