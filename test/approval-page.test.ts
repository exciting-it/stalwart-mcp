import { describe, expect, it } from "vitest";
import { pageLanguage, renderApprovalPage, renderIntroPage, renderMessagePage } from "../src/oauth/approval-page";

const base = { clientName: "Claude", redirectHost: "claude.ai", email: "a@test.example", handle: "h-123" };

/** The texts of the permission list, in page order. */
const permissions = (html: string): string[] =>
  [...html.matchAll(/<li><span class="tick" aria-hidden="true"><\/span><span>([^<]*)<\/span><\/li>/g)].map((m) => m[1]!);

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
    expect(permissions(en)).toEqual(["Read, send and manage your email"]);
    expect(en).toContain('<p class="never">It never empties the trash.</p>');
    expect(en).toContain("Not a@test.example? Choose Deny, sign out of your mailbox and try again.");
    expect(en).toContain("Only allow this if you started the connection yourself just now.");
    expect(en).toMatch(/<button[^>]*value="allow"[^>]*>Allow<\/button>/);
    expect(en).toMatch(/<button[^>]*value="deny"[^>]*>Deny<\/button>/);
    expect(en).toContain('<html lang="en">');

    const de = await renderApprovalPage({ lang: "de", ...base }).text();
    expect(de).toContain("Postfach verbinden");
    expect(de).toContain("Claude (claude.ai) möchte auf dieses Postfach zugreifen:");
    expect(de).toContain('<p class="mailbox">a@test.example</p>');
    expect(permissions(de)).toEqual(["E-Mails lesen, senden und verwalten"]);
    expect(de).toContain('<p class="never">Den Papierkorb leert sie nie.</p>');
    expect(de).toContain("Nicht a@test.example? Wähle „Ablehnen“, melde dich im Postfach ab und versuche es erneut.");
    expect(de).toContain("Erlaube das nur, wenn du die Verbindung gerade selbst gestartet hast.");
    expect(de).toMatch(/<button[^>]*value="allow"[^>]*>Erlauben<\/button>/);
    expect(de).toMatch(/<button[^>]*value="deny"[^>]*>Ablehnen<\/button>/);
    expect(de).toContain('<html lang="de">');
  });

  // The page names one permission per area, in the words of the mail server's own consent page.
  // The limits (sends per day and the like) are no longer listed here; the AI tool is told them
  // in the server instructions and the tool descriptions (test/mcp-handler.test.ts).
  it("lists one short permission per area and no numbers", async () => {
    for (const lang of ["en", "de"] as const) {
      const html = await renderApprovalPage({ lang, ...base, areas: new Set(["contacts", "calendars"] as const) }).text();
      expect(permissions(html)).toHaveLength(3);
      for (const line of permissions(html)) expect(line).not.toMatch(/\d/);
    }
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
      expect(permissions(html)).toHaveLength(1);
    }
  });

  it("adds one list entry for exactly each area that is switched on, after the mail entries", async () => {
    expect(permissions(await page("en", ["contacts"])).slice(1)).toEqual(["Read and manage your contacts"]);
    expect(await page("en", ["contacts"])).not.toMatch(/calendar/i);
    expect(permissions(await page("en", ["calendars"])).slice(1)).toEqual(["Read and manage your calendars"]);
    expect(await page("en", ["calendars"])).not.toMatch(/contact|address book/i);
    expect(permissions(await page("en", ["calendars", "contacts"])).slice(1)).toEqual([
      "Read and manage your contacts",
      "Read and manage your calendars",
    ]);
    expect(permissions(await page("de", ["contacts", "calendars"])).slice(1)).toEqual([
      "Kontakte lesen und verwalten",
      "Kalender lesen und verwalten",
    ]);
  });

  it("tells what deleting does, naming only the areas that are on", async () => {
    const note = (html: string) => /<p class="never">([^<]*)<\/p>/.exec(html)?.[1];
    // Mail only: the note is unchanged.
    expect(note(await page("en"))).toBe("It never empties the trash.");
    expect(note(await page("de", []))).toBe("Den Papierkorb leert sie nie.");
    const trash = "Deleted mail goes to the trash, which it never empties.";
    expect(note(await page("en", ["contacts"]))).toBe(`${trash} Deleted contacts are gone for good.`);
    expect(note(await page("en", ["calendars"]))).toBe(`${trash} Deleted events are gone for good.`);
    expect(note(await page("en", ["contacts", "calendars"]))).toBe(`${trash} Deleted contacts and events are gone for good.`);
    const papierkorb = "Gelöschte E-Mails landen im Papierkorb, den sie nie leert.";
    expect(note(await page("de", ["contacts"]))).toBe(`${papierkorb} Gelöschte Kontakte sind endgültig weg.`);
    expect(note(await page("de", ["calendars"]))).toBe(`${papierkorb} Gelöschte Termine sind endgültig weg.`);
    expect(note(await page("de", ["contacts", "calendars"]))).toBe(
      `${papierkorb} Gelöschte Kontakte und Termine sind endgültig weg.`,
    );
  });

  it("shows the permissions as a labelled list and not as form fields", async () => {
    const html = await page("de", ["contacts", "calendars"]);
    expect(html).toContain('<p class="may" id="may">Die Anwendung darf:</p>');
    expect(html).toContain('<ul class="perms" aria-labelledby="may">');
    // The ticks are drawn, not inputs: the only fields of the form are the handle and the two buttons,
    // so no permission can be unticked or submitted.
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).not.toMatch(/type="checkbox"/);
    expect(html.match(/<button/g)).toHaveLength(2);
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

describe("intro page", () => {
  const intro = (lang: "de" | "en", over: Partial<Parameters<typeof renderIntroPage>[0]> = {}) =>
    renderIntroPage({
      lang,
      clientName: "Claude",
      redirectHost: "claude.ai",
      mailHost: "mail.test.example",
      continueUrl: "https://mail.test.example/login?state=s&code_challenge=c",
      ...over,
    });

  it("says in two steps what happens, names the mail server and which login is meant", async () => {
    const de = await intro("de").text();
    expect(de).toContain("Claude (claude.ai) möchte sich mit deinem Postfach verbinden. Das geht in zwei Schritten:");
    expect(de).toContain("<strong>Anmelden</strong>Auf der nächsten Seite meldest du dich bei deinem Mailserver an (mail.test.example).");
    expect(de).toContain('<span class="hint">Benutze deine E-Mail-Adresse und dein Mail-Passwort.</span>');
    expect(de).toContain("<strong>Bestätigen</strong>");
    expect(de).toContain("Dein Passwort bekommt die Anwendung nie zu sehen.");
    expect(de).toContain("Fahre nur fort, wenn du die Verbindung gerade selbst gestartet hast.");
    expect(de).toMatch(/<a class="go" href="[^"]+">Weiter zur Anmeldung<\/a>/);
    const en = await intro("en").text();
    expect(en).toContain("Claude (claude.ai) wants to connect to your mailbox. This takes two steps:");
    expect(en).toContain('<span class="hint">Use your email address and your mail password.</span>');
    expect(en).toMatch(/<a class="go" href="[^"]+">Continue to sign-in<\/a>/);
  });

  it("escapes the tool's name, its host and the link, and has the same headers as the other pages", async () => {
    const res = intro("en", {
      clientName: `<img src=x onerror=1>"'&`,
      redirectHost: "<b>x.example",
      continueUrl: `https://mail.test.example/login?a=1&b="><script>alert(1)</script>`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>x.example");
    expect(html).toContain('href="https://mail.test.example/login?a=1&amp;b=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    // No form and no field: the page collects nothing, least of all a password.
    expect(html).not.toMatch(/<form|<input|<button/i);
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
