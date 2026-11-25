/**
 * The HTML this worker shows in the browser: our own approval page ("Connect mailbox X to tool
 * Y?") and the fixed message pages, in the look defined by `theme.ts`. Client name and host are
 * client-supplied, so every interpolated value is escaped. No page ever shows an error detail
 * or upstream text. The pages run no script and load only this origin's own fonts and images.
 */
import type { Area } from "../config";
import { THEME } from "./theme";

export type PageLanguage = "de" | "en";
export type MessageKind = "refused" | "failed" | "expired";

/** No `form-action`: browsers apply it to the redirect back to the AI tool after the POST. */
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** German when `Accept-Language` starts with `de`, otherwise English. */
export function pageLanguage(request: Request): PageLanguage {
  return (request.headers.get("accept-language") ?? "").trim().toLowerCase().startsWith("de") ? "de" : "en";
}

const APPROVAL_COPY = {
  en: {
    title: "Connect your mailbox",
    lead: (client: string, host: string) => `${client} (${host}) wants to access this mailbox:`,
    scope:
      "It will be able to read and search your mail, save drafts, send mail in your name (at most 50 messages per day) and move messages to other folders or to the trash. It never empties the trash.",
    wrongMailbox: (email: string) => `Not ${email}? Choose Deny, sign out of your mailbox and try again.`,
    also: {
      contacts: "It can also read your address book.",
      calendars: "It can also read your calendars.",
      both: "It can also read your calendars and your address book.",
    },
    caution: "Only allow this if you started the connection yourself just now.",
    allow: "Allow",
    deny: "Deny",
  },
  de: {
    title: "Postfach verbinden",
    lead: (client: string, host: string) => `${client} (${host}) möchte auf dieses Postfach zugreifen:`,
    scope:
      "Die Anwendung kann deine E-Mails lesen und durchsuchen, Entwürfe speichern, in deinem Namen senden (höchstens 50 Nachrichten pro Tag) und Nachrichten in andere Ordner oder in den Papierkorb verschieben. Den Papierkorb leert sie nie.",
    wrongMailbox: (email: string) =>
      `Nicht ${email}? Wähle „Ablehnen“, melde dich im Postfach ab und versuche es erneut.`,
    also: {
      contacts: "Außerdem kann sie dein Adressbuch lesen.",
      calendars: "Außerdem kann sie deine Kalender lesen.",
      both: "Außerdem kann sie deine Kalender und dein Adressbuch lesen.",
    },
    caution: "Erlaube das nur, wenn du die Verbindung gerade selbst gestartet hast.",
    allow: "Erlauben",
    deny: "Ablehnen",
  },
} as const;

const MESSAGE_COPY: Record<MessageKind, Record<PageLanguage, string>> = {
  refused: {
    en: "This mailbox cannot be connected.",
    de: "Dieses Postfach kann nicht verbunden werden.",
  },
  failed: {
    en: "The connection could not be completed. Please start again from your AI tool.",
    de: "Die Verbindung konnte nicht abgeschlossen werden. Bitte starte erneut in deinem KI-Werkzeug.",
  },
  expired: {
    en: "This request has expired. Please start again from your AI tool.",
    de: "Diese Anfrage ist abgelaufen. Bitte starte erneut in deinem KI-Werkzeug.",
  },
};

const { colors: C, fonts: F } = THEME;
const DISPLAY = `"${F.display.family}","${F.body.family}",sans-serif`;
const BODY = `"${F.body.family}",system-ui,sans-serif`;

const fontFace = (f: { family: string; src: string; weight: string }): string =>
  `@font-face{font-family:"${f.family}";src:url("${f.src}") format("woff2");font-weight:${f.weight};font-style:normal;font-display:swap}`;

/** Built from `THEME` only: no request value ever reaches the style sheet. */
const STYLE = [
  fontFace(F.display),
  fontFace(F.body),
  "*,*::before,*::after{box-sizing:border-box}",
  "html,body{margin:0;min-height:100%}",
  `body{font-family:${BODY};font-size:16px;line-height:1.5;letter-spacing:-.005em;color:${C.ink};background:${C.background};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}`,
  ".page{display:flex;min-height:100vh}",
  `.pane{display:flex;flex-direction:column;width:100%;padding:1.5rem;background:radial-gradient(1200px 700px at 8% -10%,rgba(163,203,183,.5),transparent 60%),radial-gradient(900px 600px at 100% 10%,rgba(210,230,218,.55),transparent 55%),linear-gradient(180deg,${C.background},${C.backgroundDeep})}`,
  `.brand{margin:0;font-family:${DISPLAY};font-size:1.125rem;font-weight:700;letter-spacing:-.025em;color:${C.wordmark}}`,
  `.dot{color:${C.accent}}`,
  ".center{flex:1;display:flex;align-items:center;justify-content:center}",
  ".box{width:100%;max-width:24rem;padding:2.5rem 0}",
  `h1{margin:0;font-family:${DISPLAY};font-weight:800;font-size:clamp(2rem,5.5vw,3.1rem);line-height:1.08;letter-spacing:-.02em}`,
  `.sub{margin:.5rem 0 0;font-size:.875rem;color:${C.muted}}`,
  `.mailbox{margin:1.5rem 0 0;padding:.75rem 1rem;border:1px solid ${C.border};border-radius:1rem;background:${C.surface};font-weight:600;overflow-wrap:anywhere;box-shadow:0 8px 32px -8px rgba(14,70,35,.18)}`,
  ".text{margin:1rem 0 0;font-size:.875rem}",
  ".caution{margin:1rem 0 0;font-size:.875rem;font-weight:600}",
  "form{display:flex;gap:.75rem;margin:2rem 0 0}",
  `button{font:inherit;font-size:.875rem;font-weight:500;height:2.5rem;padding:0 1.25rem;border-radius:.875rem;border:1px solid ${C.border};background:${C.background};color:${C.ink};cursor:pointer;transition:background-color .15s ease}`,
  `button[value=allow]{flex:1;border-color:${C.primary};background:${C.primary};color:${C.onPrimary};box-shadow:0 1px 2px rgba(14,70,35,.2)}`,
  `button[value=allow]:hover{background:${C.primaryHover}}`,
  `button[value=deny]:hover{background:${C.soft}}`,
  `button:focus-visible{outline:2px solid ${C.ring};outline-offset:2px}`,
  `.note{margin:2.5rem 0 0;font-size:.75rem;color:${C.muted};overflow-wrap:anywhere}`,
  ".art{display:none;position:relative;overflow:hidden}",
  ".art img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;animation:breathe 12s ease-in-out infinite alternate}",
  ".scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.7),rgba(0,0,0,.25),transparent)}",
  ".claim{position:absolute;left:2.5rem;right:2.5rem;bottom:2.5rem;color:#fff}",
  `.claim h2{margin:0;font-family:${DISPLAY};font-size:2.25rem;font-weight:700;line-height:1.25;letter-spacing:-.025em}`,
  ".claim p{margin:1rem 0 0;max-width:28rem;font-size:.875rem;color:rgba(255,255,255,.8)}",
  "@keyframes breathe{from{transform:scale(1.02)}to{transform:scale(1.07)}}",
  "@media (min-width:40rem){.pane{padding:1.5rem 2.5rem}}",
  "@media (min-width:64rem){.pane{width:50%}.art{display:block;width:50%}}",
  "@media (prefers-reduced-motion:reduce){.art img{animation:none;transform:scale(1.02)}}",
].join("");

const DOT = '<span class="dot">.</span>';
const WORDMARK = `${escapeHtml(THEME.wordmark).replace(/ /g, "&nbsp;")}${DOT}`;

function artwork(lang: PageLanguage): string {
  const claim = THEME.artwork.claim[lang];
  return `<div class="art">
<img src="${escapeHtml(THEME.artwork.src)}" alt="" aria-hidden="true">
<div class="scrim"></div>
<div class="claim">
<h2>${claim.lines.map(escapeHtml).join("<br>")}${DOT}</h2>
<p>${escapeHtml(claim.text)}</p>
</div>
</div>`;
}

/** `body` is trusted markup; every value in it must already be escaped. */
function htmlResponse(lang: PageLanguage, title: string, body: string, status: number): Response {
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(THEME.wordmark)}</title>
<link rel="icon" href="${escapeHtml(THEME.icon)}">
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<div class="pane">
<p class="brand">${WORDMARK}</p>
<main class="center">
<div class="box">
<h1>${escapeHtml(title)}${DOT}</h1>
${body}
</div>
</main>
</div>
${artwork(lang)}
</div>
</body>
</html>
`;
  return new Response(html, { status, headers: HTML_HEADERS });
}

export function renderApprovalPage(p: {
  lang: PageLanguage;
  clientName: string;
  redirectHost: string;
  email: string;
  handle: string;
  /** The areas beyond mail this deployment asks for; the page names each of them. */
  areas?: ReadonlySet<Area>;
}): Response {
  const t = APPROVAL_COPY[p.lang];
  const contacts = p.areas?.has("contacts") ?? false;
  const calendars = p.areas?.has("calendars") ?? false;
  const also = contacts && calendars ? t.also.both : contacts ? t.also.contacts : calendars ? t.also.calendars : null;
  const client = escapeHtml(p.clientName);
  const host = escapeHtml(p.redirectHost);
  const email = escapeHtml(p.email);
  const body = `<p class="sub">${t.lead(client, host)}</p>
<p class="mailbox">${email}</p>
<p class="text">${escapeHtml(t.scope)}</p>${also === null ? "" : `\n<p class="text">${escapeHtml(also)}</p>`}
<p class="caution">${escapeHtml(t.caution)}</p>
<form method="post" action="/approve">
<input type="hidden" name="h" value="${escapeHtml(p.handle)}">
<button type="submit" name="decision" value="allow">${escapeHtml(t.allow)}</button>
<button type="submit" name="decision" value="deny">${escapeHtml(t.deny)}</button>
</form>
<p class="note">${t.wrongMailbox(email)}</p>`;
  return htmlResponse(p.lang, t.title, body, 200);
}

export function renderMessagePage(p: { lang: PageLanguage; kind: MessageKind; status: number }): Response {
  const text = escapeHtml(MESSAGE_COPY[p.kind][p.lang]);
  return htmlResponse(p.lang, APPROVAL_COPY[p.lang].title, `<p class="sub">${text}</p>`, p.status);
}
