import { MAIL_LIMITS } from "../src/mail";
import { describe, expect, it } from "vitest";
import { pageLanguage, renderApprovalPage, renderMessagePage } from "../src/oauth/approval-page";

const base = { clientName: "Claude", redirectHost: "claude.ai", email: "a@test.example", handle: "h-123" };

describe("approval page", () => {
  it("escapes client name, host and address", async () => {
    const html = await renderApprovalPage({
      lang: "en",
      clientName: `<img src=x onerror=1>"'&`,
      redirectHost: "<b>x.example",
      email: "a\"@test.example",
      handle: `h"><script>`,
    }).text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;x.example");
    expect(html).toContain("a&quot;@test.example");
    expect(html).toContain("&quot;&#39;&amp;");
  });

  it("cannot be framed and is never cached", () => {
    const pages = [
      renderApprovalPage({ lang: "en", ...base }),
      renderMessagePage({ lang: "de", kind: "failed", status: 400 }),
    ];
    for (const res of pages) {
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).not.toContain("form-action");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
  });

  it("names the mailbox and the tool in German and in English", async () => {
    const en = await renderApprovalPage({ lang: "en", ...base }).text();
    expect(en).toContain("Connect your mailbox");
    expect(en).toContain("Claude (claude.ai) wants to read, search and send email for a@test.example.");
    expect(en).toContain(
      "It will be able to read and search your mail, save drafts and send mail in your name (at most 50 messages per day). It cannot delete mail.",
    );
    expect(en).toContain("Not a@test.example? Choose Deny, sign out of your mailbox and try again.");
    expect(en).toContain("Only allow this if you started the connection yourself just now.");
    expect(en).toMatch(/<button[^>]*value="allow"[^>]*>Allow<\/button>/);
    expect(en).toMatch(/<button[^>]*value="deny"[^>]*>Deny<\/button>/);
    expect(en).toContain('<html lang="en">');

    const de = await renderApprovalPage({ lang: "de", ...base }).text();
    expect(de).toContain("Postfach verbinden");
    expect(de).toContain("Claude (claude.ai) möchte für a@test.example E-Mails lesen, durchsuchen und senden.");
    expect(de).toContain(
      "Die Anwendung kann Ihre E-Mails lesen und durchsuchen, Entwürfe speichern und in Ihrem Namen senden (höchstens 50 Nachrichten pro Tag). Löschen kann sie nichts.",
    );
    expect(de).toContain("Nicht a@test.example? Wählen Sie „Ablehnen“, melden Sie sich im Postfach ab und versuchen Sie es erneut.");
    expect(de).toContain("Erlauben Sie das nur, wenn Sie die Verbindung gerade selbst gestartet haben.");
    expect(de).toMatch(/<button[^>]*value="allow"[^>]*>Erlauben<\/button>/);
    expect(de).toMatch(/<button[^>]*value="deny"[^>]*>Ablehnen<\/button>/);
    expect(de).toContain('<html lang="de">');
  });

  it("states the daily send limit of the contract in both languages", async () => {
    const en = await renderApprovalPage({ lang: "en", ...base }).text();
    const de = await renderApprovalPage({ lang: "de", ...base }).text();
    expect(Number(/at most (\d+) messages per day/.exec(en)?.[1])).toBe(MAIL_LIMITS.sendsPerDay);
    expect(Number(/höchstens (\d+) Nachrichten pro Tag/.exec(de)?.[1])).toBe(MAIL_LIMITS.sendsPerDay);
  });

  it("posts the handle to /approve", async () => {
    const html = await renderApprovalPage({ lang: "en", ...base }).text();
    expect(html).toMatch(/<form method="post" action="\/approve">/);
    expect(html).toContain('<input type="hidden" name="h" value="h-123">');
  });
});

describe("message pages", () => {
  it.each([
    ["refused", 403, "This mailbox cannot be connected.", "Dieses Postfach kann nicht verbunden werden."],
    [
      "failed",
      400,
      "The connection could not be completed. Please start again from your AI tool.",
      "Die Verbindung konnte nicht abgeschlossen werden. Bitte starten Sie erneut in Ihrem KI-Werkzeug.",
    ],
    [
      "expired",
      410,
      "This request has expired. Please start again from your AI tool.",
      "Diese Anfrage ist abgelaufen. Bitte starten Sie erneut in Ihrem KI-Werkzeug.",
    ],
  ] as const)("%s has its fixed copy and status", async (kind, status, en, de) => {
    const resEn = renderMessagePage({ lang: "en", kind, status });
    expect(resEn.status).toBe(status);
    expect(await resEn.text()).toContain(en);
    expect(await renderMessagePage({ lang: "de", kind, status }).text()).toContain(de);
  });
});

describe("pageLanguage", () => {
  it("is German only when Accept-Language starts with de", () => {
    const lang = (v: string | null) =>
      pageLanguage(new Request("https://t.example/", v === null ? {} : { headers: { "accept-language": v } }));
    expect(lang("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(lang("DE")).toBe("de");
    expect(lang("en-US,de;q=0.9")).toBe("en");
    expect(lang(null)).toBe("en");
  });
});
