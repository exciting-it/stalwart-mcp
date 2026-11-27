import { describe, expect, it } from "vitest";
import { pageLanguage, renderApprovalPage, renderIntroPage, renderMessagePage } from "../src/oauth/approval-page";
import { APPROVAL_SCRIPT } from "../src/oauth/approval-script";

const base = { clientName: "Claude", redirectHost: "claude.ai", email: "a@test.example", handle: "h-123" };

/** The policy of the pages that run no script. */
const NO_SCRIPT_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'";
/** The approval page's one script element, as it stands in the page. */
const SCRIPT_ELEMENT = `<script>${APPROVAL_SCRIPT}</script>`;
/** The page without that element: what is left must hold no script at all. */
const withoutItsScript = (html: string): string => {
  expect(html.split(SCRIPT_ELEMENT)).toHaveLength(2);
  return html.replace(SCRIPT_ELEMENT, "");
};

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
    // The only script is the page's own; the one in the handle stays text.
    expect(withoutItsScript(html)).not.toContain("<script");
    expect(html).toContain('value="h&quot;&gt;&lt;script&gt;"');
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
    // No script may run on a message page; the approval page's policy is checked with its script below.
    expect(pages[1]!.headers.get("content-security-policy")).toBe(NO_SCRIPT_POLICY);
    expect(pages[1]!.headers.get("content-security-policy")).not.toContain("script-src");
    for (const res of pages) {
      // Nothing loads from another origin, and nothing inline runs without being named.
      expect(res.headers.get("content-security-policy")).not.toMatch(/https?:|\*|data:|unsafe-eval|nonce-/);
      expect(res.headers.get("content-security-policy")).toMatch(/^default-src 'none';/);
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

  it("runs no script but the approval page's own and loads only this origin's own files", async () => {
    const [approval, message] = await Promise.all(pages().map((res) => res.text()));
    for (const html of [withoutItsScript(approval!), message!]) {
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
    expect(res.headers.get("content-security-policy")).toBe(NO_SCRIPT_POLICY);
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

describe("tools already connected, on the approval page", () => {
  const sha256 = async (text: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const KEY_N8N = "a".repeat(32);
  const KEY_EMPTY = "b".repeat(32);
  const KEY_LONG = "c".repeat(32);
  const KEY_SELF = "d".repeat(32);
  const MARCH_3 = Date.UTC(2026, 2, 3, 12) / 1000;
  const JUNE_20 = Date.UTC(2026, 5, 20, 12) / 1000;
  const tools = {
    replaced: { key: KEY_SELF, name: "Claude", since: JUNE_20 },
    others: [
      { key: KEY_N8N, name: "<script>alert(1)</script>", since: MARCH_3 },
      { key: KEY_EMPTY, name: "", since: MARCH_3 },
      { key: KEY_LONG, name: "n8n", since: JUNE_20 },
    ],
    rest: [],
  };
  /** The fields a browser would post, as [name, value] pairs. */
  const fields = (html: string) =>
    [...html.matchAll(/<input type="(hidden|checkbox)"(?: id="[^"]+")? name="([^"]+)" value="([^"]*)"( checked)?>/g)].map(
      (m) => [m[1], m[2], m[3], m[4] !== undefined] as const,
    );

  it("is byte for byte today's page when no other tool has access", async () => {
    // Pinned anew with the feedback after Allow or Deny (status line, styles, script): that change
    // is on every approval page. The list of tools still adds nothing when there is none.
    const today = "5b0db17aac5f5bcb58b78f920c9ed31c8f715aa6e0f65d30945fc82cd106c8df";
    const plain = { lang: "en" as const, ...base };
    expect(await sha256(await renderApprovalPage(plain).text())).toBe(today);
    const empty = await renderApprovalPage({ ...plain, tools: { replaced: null, others: [], rest: [] } }).text();
    expect(await sha256(empty)).toBe(today);
  });

  it("lists the tools between the permissions and the buttons, inside the form, with ticked, labelled checkboxes", async () => {
    const html = await renderApprovalPage({ lang: "en", ...base, tools }).text();
    const form = /<form method="post" action="\/approve">([\s\S]*?)<\/form>/.exec(html)![1]!;
    expect(html.indexOf('<ul class="perms" aria-labelledby="may">')).toBeLessThan(html.indexOf('<fieldset class="tools">'));
    expect(form.indexOf("</fieldset>")).toBeLessThan(form.indexOf("<button"));
    expect(form).toContain('<legend class="may">These tools already have access to this mailbox:</legend>');
    expect(form).toContain('<p class="never">A tool you untick loses its access when you allow this connection.</p>');

    const boxes = [...form.matchAll(/<input type="checkbox" id="([^"]+)" name="keep" value="([^"]+)" checked>/g)];
    expect(boxes.map((m) => m[2])).toEqual([KEY_N8N, KEY_EMPTY, KEY_LONG]);
    // Every checkbox has its own label, bound by id.
    for (const [, id] of boxes) expect(form.match(new RegExp(`<label for="${id}">`, "g"))).toHaveLength(1);
    expect(new Set(boxes.map((m) => m[1])).size).toBe(3);
    // Every entry posts its key as shown; the connecting tool's own earlier connection has no checkbox.
    expect(fields(form).filter(([type, name]) => type === "hidden" && name === "shown").map(([, , v]) => v)).toEqual([
      KEY_SELF,
      KEY_N8N,
      KEY_EMPTY,
      KEY_LONG,
    ]);
    expect(form).not.toContain(`name="keep" value="${KEY_SELF}"`);
  });

  it("escapes the names, uses a fixed name for a tool without one and shows the dates in the page's language", async () => {
    const en = await renderApprovalPage({ lang: "en", ...base, tools }).text();
    expect(withoutItsScript(en)).not.toContain("<script>");
    expect(en).toContain('<span class="name">&lt;script&gt;alert(1)&lt;/script&gt;</span> stays connected');
    expect(en).toContain('<span class="name">Unnamed tool</span> stays connected');
    expect(en).toContain('<span class="when">Connected since 3 March 2026</span>');
    expect(en).toContain('<span class="when">Connected since 20 June 2026</span>');
    expect(en).toContain(
      '<span class="name">Claude</span><span class="when">This tool&#39;s earlier connection, since 20 June 2026. Allowing replaces it.</span>',
    );

    const de = await renderApprovalPage({ lang: "de", ...base, tools }).text();
    expect(de).toContain('<legend class="may">Diese Werkzeuge haben schon Zugriff auf dieses Postfach:</legend>');
    expect(de).toContain('<span class="name">Unbenanntes Werkzeug</span> bleibt verbunden');
    expect(de).toContain('<span class="when">Verbunden seit 3. März 2026</span>');
    expect(de).toContain(
      '<span class="name">Claude</span><span class="when">Frühere Verbindung dieses Werkzeugs, seit 20. Juni 2026. Erlauben ersetzt sie.</span>',
    );
    expect(de).toContain(
      '<p class="never">Ein Werkzeug ohne Haken verliert seinen Zugriff, wenn du diese Verbindung erlaubst.</p>',
    );
  });

  it("decides the tools beyond the first 20 as one entry", async () => {
    const rest = ["1", "2", "3"].map((c) => c.repeat(32));
    const html = await renderApprovalPage({ lang: "en", ...base, tools: { replaced: null, others: tools.others, rest } }).text();
    expect(html).toContain('<input type="checkbox" id="tool-rest" name="keep" value="rest" checked>');
    expect(html).toContain('<label for="tool-rest"><span class="name">3 more tools</span> stay connected</label>');
    const posted = fields(html);
    for (const key of rest) {
      expect(posted).toContainEqual(["hidden", "shown", key, false]);
      expect(posted).toContainEqual(["hidden", "rest", key, false]);
    }
    const de = await renderApprovalPage({ lang: "de", ...base, tools: { replaced: null, others: [], rest } }).text();
    expect(de).toContain('<label for="tool-rest"><span class="name">3 weitere Werkzeuge</span> bleiben verbunden</label>');
  });

  it("without other tools, the connecting tool's earlier connection is named but nothing asks to untick", async () => {
    const html = await renderApprovalPage({ lang: "en", ...base, tools: { replaced: tools.replaced, others: [], rest: [] } }).text();
    expect(html).toContain('<fieldset class="tools">');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("untick");
  });

  it("keeps the page free of any script but its own and of foreign addresses", async () => {
    const html = withoutItsScript(await renderApprovalPage({ lang: "de", ...base, tools }).text());
    expect(html).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe("feedback after Allow or Deny", () => {
  const sha256Base64 = async (text: string) =>
    btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))));
  const hostile = {
    lang: "de" as const,
    clientName: `</script><script>alert(1)</script>`,
    redirectHost: `"];alert(1);//`,
    email: `'+alert(1)+'@test.example`,
    handle: `h"></script><script>alert(1)`,
  };

  it("allows exactly the script that is on the page, by its hash", async () => {
    const res = renderApprovalPage({ lang: "en", ...base });
    const html = await res.text();
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    // Inline and without any attribute: no address to load from, no nonce.
    expect(scripts[0]![1]).toBe("");
    expect(scripts[0]![2]).toBe(APPROVAL_SCRIPT);
    expect(res.headers.get("content-security-policy")).toBe(
      `default-src 'none'; script-src 'sha256-${await sha256Base64(scripts[0]![2]!)}'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    expect(res.headers.get("content-security-policy")).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|self|nonce-|https?:|\*)/);
  });

  it("is the same fixed script whatever the request holds", async () => {
    const plain = renderApprovalPage({ lang: "en", ...base });
    const policy = plain.headers.get("content-security-policy");
    const tools = { replaced: null, others: [{ key: "a".repeat(32), name: `</script><script>x`, since: 1_800_000_000 }], rest: [] };
    for (const res of [renderApprovalPage(hostile), renderApprovalPage({ ...hostile, lang: "en", tools })]) {
      expect(res.headers.get("content-security-policy")).toBe(policy);
      // Removing the page's own script leaves none: every hostile value stayed text.
      expect(withoutItsScript(await res.text())).not.toMatch(/<script|<\/script/i);
    }
  });

  it("cannot end its own element and reaches for nothing beyond the page", () => {
    expect(APPROVAL_SCRIPT).not.toContain("<");
    expect(APPROVAL_SCRIPT).not.toMatch(/https?:|fetch|XMLHttpRequest|sendBeacon|WebSocket|import|eval|Function\(/);
    expect(APPROVAL_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacent|document\.write|cookie|Storage|location/);
    // Sentences are set as text, read from the status element's own attributes.
    expect(APPROVAL_SCRIPT.match(/textContent=/g)).toEqual(Array(3).fill("textContent="));
    expect(APPROVAL_SCRIPT.match(/textContent=(status\.getAttribute\(|"")/g)).toHaveLength(3);
  });

  it("locks the buttons without disabling them, so the decision is still posted", () => {
    expect(APPROVAL_SCRIPT).toContain("if(sent){e.preventDefault();return}");
    expect(APPROVAL_SCRIPT).toContain('setAttribute("aria-disabled","true")');
    expect(APPROVAL_SCRIPT.replace(/aria-disabled/g, "")).not.toContain("disabled");
    // A page that comes back from the browser's back/forward cache can be used again.
    expect(APPROVAL_SCRIPT).toContain('addEventListener("pageshow"');
    expect(APPROVAL_SCRIPT).toContain("if(!e.persisted)return");
  });

  it("has an empty status line after the form that carries the sentences in the page's language", async () => {
    const status = (html: string) => /<\/form>\n<p class="status" id="status" role="status"([^>]*)><\/p>/.exec(html)?.[1];
    const attributes = (html: string) =>
      Object.fromEntries([...status(html)!.matchAll(/ (data-[a-z-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
    expect(attributes(await renderApprovalPage({ lang: "en", ...base }).text())).toEqual({
      "data-allow": "Connecting. You will be sent back to your AI tool in a moment.",
      "data-deny": "Declining. You will be sent back to your AI tool in a moment.",
      "data-late-allow":
        "This is taking longer than usual. If your AI tool already shows the connection, you can close this window.",
      "data-late-deny": "This is taking longer than usual. You can close this window.",
    });
    const de = attributes(await renderApprovalPage(hostile).text());
    expect(de).toEqual({
      "data-allow": "Die Verbindung wird hergestellt. Gleich geht es zurück zu deinem KI-Werkzeug.",
      "data-deny": "Die Anfrage wird abgelehnt. Gleich geht es zurück zu deinem KI-Werkzeug.",
      "data-late-allow":
        "Das dauert länger als üblich. Zeigt dein KI-Werkzeug die Verbindung schon an, kannst du dieses Fenster schließen.",
      "data-late-deny": "Das dauert länger als üblich. Du kannst dieses Fenster schließen.",
    });
    // Every attribute the script reads exists, and it reads no other.
    for (const kind of ["allow", "deny"]) for (const prefix of ["data-", "data-late-"]) expect(de).toHaveProperty(prefix + kind);
    expect(APPROVAL_SCRIPT.match(/getAttribute\("[^"]*"/g)).toEqual(['getAttribute("data-"', 'getAttribute("data-late-"']);
  });

  it("styles the waiting state and stops the turning ring for reduced motion", async () => {
    const html = await renderApprovalPage({ lang: "en", ...base }).text();
    for (const className of ["busy", "sent"]) expect(APPROVAL_SCRIPT).toContain(`classList.add("${className}")`);
    expect(html).toContain("form.busy button{pointer-events:none;cursor:default}");
    expect(html).toContain("button.sent::before{");
    expect(html).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^@]*button\.sent::before\{animation:none\}/);
  });

  it("is on the approval page only", async () => {
    const others = [
      renderMessagePage({ lang: "de", kind: "failed", status: 400 }),
      renderMessagePage({ lang: "en", kind: "expired", status: 410 }),
      renderIntroPage({ lang: "de", clientName: "Claude", redirectHost: "claude.ai", mailHost: "mail.test.example", continueUrl: "https://mail.test.example/login" }),
    ];
    for (const res of others) {
      expect(res.headers.get("content-security-policy")).toBe(NO_SCRIPT_POLICY);
      const html = await res.text();
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain('id="status"');
    }
  });
});
