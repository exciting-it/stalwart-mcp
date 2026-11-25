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
    // The only image is the page's own artwork; the client-supplied one stays text.
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror=1>");
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
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      // No script may run, and nothing loads from another origin.
      expect(res.headers.get("content-security-policy")).not.toMatch(/script-src|https?:|\*|data:/);
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
    expect(en).toContain("Claude (claude.ai) wants to access this mailbox:");
    expect(en).toContain('<p class="mailbox">a@test.example</p>');
    expect(en).toContain(
      "It will be able to read and search your mail, save drafts, send mail in your name (at most 50 messages per day) and move messages to other folders or to the trash. It never empties the trash.",
    );
    expect(en).toContain("Not a@test.example? Choose Deny, sign out of your mailbox and try again.");
    expect(en).toContain("Only allow this if you started the connection yourself just now.");
    expect(en).toMatch(/<button[^>]*value="allow"[^>]*>Allow<\/button>/);
    expect(en).toMatch(/<button[^>]*value="deny"[^>]*>Deny<\/button>/);
    expect(en).toContain('<html lang="en">');

    const de = await renderApprovalPage({ lang: "de", ...base }).text();
    expect(de).toContain("Postfach verbinden");
    expect(de).toContain("Claude (claude.ai) möchte auf dieses Postfach zugreifen:");
    expect(de).toContain('<p class="mailbox">a@test.example</p>');
    expect(de).toContain(
      "Die Anwendung kann deine E-Mails lesen und durchsuchen, Entwürfe speichern, in deinem Namen senden (höchstens 50 Nachrichten pro Tag) und Nachrichten in andere Ordner oder in den Papierkorb verschieben. Den Papierkorb leert sie nie.",
    );
    expect(de).toContain("Nicht a@test.example? Wähle „Ablehnen“, melde dich im Postfach ab und versuche es erneut.");
    expect(de).toContain("Erlaube das nur, wenn du die Verbindung gerade selbst gestartet hast.");
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

describe("areas beyond mail on the approval page", () => {
  const page = (lang: "de" | "en", areas?: ("contacts" | "calendars")[]) =>
    renderApprovalPage({ lang, ...base, areas: areas === undefined ? undefined : new Set(areas) }).text();

  it("says nothing about calendars or contacts when the deployment offers only mail", async () => {
    for (const html of [await page("en"), await page("en", []), await page("de", [])]) {
      expect(html).not.toMatch(/calendar|address book|Kalender|Adressbuch/i);
    }
  });

  it("names exactly the areas that are switched on", async () => {
    expect(await page("en", ["contacts"])).toContain("It can also read your address book.");
    expect(await page("en", ["contacts"])).not.toMatch(/calendar/i);
    expect(await page("en", ["calendars"])).toContain("It can also read your calendars.");
    expect(await page("en", ["calendars"])).not.toMatch(/address book/i);
    expect(await page("en", ["contacts", "calendars"])).toContain("It can also read your calendars and your address book.");
    expect(await page("de", ["contacts", "calendars"])).toContain("Außerdem kann sie deine Kalender und dein Adressbuch lesen.");
    expect(await page("de", ["contacts"])).toContain("Außerdem kann sie dein Adressbuch lesen.");
    expect(await page("de", ["calendars"])).toContain("Außerdem kann sie deine Kalender lesen.");
  });
});

describe("page design", () => {
  const pages = () => [
    renderApprovalPage({ lang: "de", ...base }),
    renderMessagePage({ lang: "en", kind: "expired", status: 410 }),
  ];

  it("runs no script and loads only this origin's own files", async () => {
    for (const res of pages()) {
      const html = await res.text();
      expect(html).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
      // Every address in the page (fonts, image, icon, form) is a path on this origin.
      const addresses = [...html.matchAll(/(?:src|href|action)="([^"]*)"|url\("([^"]*)"\)/g)].map((m) => m[1] ?? m[2]!);
      expect(addresses.length).toBeGreaterThanOrEqual(4);
      for (const address of addresses) expect(address).toMatch(/^\/(?!\/)/);
      expect(html).not.toMatch(/https?:\/\//);
    }
  });

  it("shows the wordmark, the title with its dot and the artwork with an empty alt text", async () => {
    for (const res of pages()) {
      const html = await res.text();
      expect(html).toContain('<p class="brand">exciting&nbsp;IT<span class="dot">.</span></p>');
      expect(html).toMatch(/<h1>[^<]+<span class="dot">\.<\/span><\/h1>/);
      expect(html).toContain('<img src="/brand/artwork.jpg" alt="" aria-hidden="true">');
    }
  });

  // That each of these files exists in public/ is checked outside the Workers runtime, by
  // `bun run check:brand` (scripts/check-brand.ts): tests here cannot read the file system.
  it("references exactly these four brand files", async () => {
    const html = await renderApprovalPage({ lang: "de", ...base }).text();
    const files = [...html.matchAll(/"(\/brand\/[^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(files)).toEqual(
      new Set([
        "/brand/fonts/bricolage-grotesque.woff2",
        "/brand/fonts/instrument-sans.woff2",
        "/brand/favicon.svg",
        "/brand/artwork.jpg",
      ]),
    );
  });
});

describe("message pages", () => {
  it.each([
    ["refused", 403, "This mailbox cannot be connected.", "Dieses Postfach kann nicht verbunden werden."],
    [
      "failed",
      400,
      "The connection could not be completed. Please start again from your AI tool.",
      "Die Verbindung konnte nicht abgeschlossen werden. Bitte starte erneut in deinem KI-Werkzeug.",
    ],
    [
      "expired",
      410,
      "This request has expired. Please start again from your AI tool.",
      "Diese Anfrage ist abgelaufen. Bitte starte erneut in deinem KI-Werkzeug.",
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
