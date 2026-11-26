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
    may: "The application may:",
    permissions: {
      mail: "Read, send and manage your email",
      contacts: "Read and manage your contacts",
      calendars: "Read and manage your calendars",
    },
    never: "It never empties the trash.",
    neverWithAreas: (gone: string) => `Deleted mail goes to the trash, which it never empties. Deleted ${gone} are gone for good.`,
    gone: { contacts: "contacts", calendars: "events", both: "contacts and events" },
    wrongMailbox: (email: string) => `Not ${email}? Choose Deny, sign out of your mailbox and try again.`,
    caution: "Only allow this if you started the connection yourself just now.",
    allow: "Allow",
    deny: "Deny",
  },
  de: {
    title: "Postfach verbinden",
    lead: (client: string, host: string) => `${client} (${host}) möchte auf dieses Postfach zugreifen:`,
    may: "Die Anwendung darf:",
    permissions: {
      mail: "E-Mails lesen, senden und verwalten",
      contacts: "Kontakte lesen und verwalten",
      calendars: "Kalender lesen und verwalten",
    },
    never: "Den Papierkorb leert sie nie.",
    neverWithAreas: (gone: string) => `Gelöschte E-Mails landen im Papierkorb, den sie nie leert. Gelöschte ${gone} sind endgültig weg.`,
    gone: { contacts: "Kontakte", calendars: "Termine", both: "Kontakte und Termine" },
    wrongMailbox: (email: string) =>
      `Nicht ${email}? Wähle „Ablehnen“, melde dich im Postfach ab und versuche es erneut.`,
    caution: "Erlaube das nur, wenn du die Verbindung gerade selbst gestartet hast.",
    allow: "Erlauben",
    deny: "Ablehnen",
  },
} as const;

/** What every connection may do, in the order shown; the areas of the deployment follow. */
const MAIL_PERMISSIONS = ["mail"] as const;
const AREA_PERMISSIONS = ["contacts", "calendars"] as const;

/** The page before the sign-in at the mail server: what is about to happen, in two steps. */
const INTRO_COPY = {
  en: {
    lead: (client: string, host: string) => `${client} (${host}) wants to connect to your mailbox. This takes two steps:`,
    signIn: "Sign in",
    signInText: (mailHost: string) => `On the next page you sign in at your mail server (${mailHost}).`,
    confirm: "Confirm",
    confirmText: "Then you come back here, see what the application may do, and confirm the connection.",
    password: "The application never sees your password.",
    go: "Continue to sign-in",
    caution: "Only continue if you started the connection yourself just now.",
  },
  de: {
    lead: (client: string, host: string) => `${client} (${host}) möchte sich mit deinem Postfach verbinden. Das geht in zwei Schritten:`,
    signIn: "Anmelden",
    signInText: (mailHost: string) => `Auf der nächsten Seite meldest du dich bei deinem Mailserver an (${mailHost}).`,
    confirm: "Bestätigen",
    confirmText: "Danach kommst du hierher zurück, siehst, was die Anwendung darf, und bestätigst die Verbindung.",
    password: "Dein Passwort bekommt die Anwendung nie zu sehen.",
    go: "Weiter zur Anmeldung",
    caution: "Fahre nur fort, wenn du die Verbindung gerade selbst gestartet hast.",
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
  // The permissions: a list, drawn as ticked boxes that cannot be changed. They are not form
  // fields, so nothing here is ever submitted or could be unticked by a script-free page.
  `.may{margin:1.5rem 0 0;font-size:.75rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${C.muted}}`,
  `.perms{list-style:none;margin:.5rem 0 0;padding:.25rem 1rem;border:1px solid ${C.border};border-radius:1rem;background:${C.surface}}`,
  ".perms li{display:flex;align-items:flex-start;gap:.75rem;padding:.625rem 0;font-size:.875rem;line-height:1.35}",
  `.perms li+li{border-top:1px solid ${C.border}}`,
  `.tick{flex:none;position:relative;width:1.125rem;height:1.125rem;margin-top:.0625rem;border-radius:.3125rem;background:${C.primary};opacity:.8}`,
  `.tick::after{content:"";position:absolute;left:.375rem;top:.1875rem;width:.3125rem;height:.5625rem;border:solid ${C.onPrimary};border-width:0 2px 2px 0;transform:rotate(45deg)}`,
  `.never{margin:.625rem 0 0;font-size:.75rem;color:${C.muted}}`,
  // The intro page: two numbered steps and one link that leaves for the mail server's sign-in.
  ".steps{list-style:none;margin:1.5rem 0 0;padding:0;counter-reset:step}",
  ".steps li{position:relative;padding:0 0 1.125rem 2.75rem;font-size:.875rem;line-height:1.45}",
  `.steps li::before{counter-increment:step;content:counter(step);position:absolute;left:0;top:-.0625rem;display:flex;align-items:center;justify-content:center;width:1.875rem;height:1.875rem;border-radius:50%;border:1px solid ${C.border};background:${C.surface};font-weight:600;font-size:.8125rem}`,
  ".steps strong{display:block;font-weight:600}",
  `.steps .hint{display:block;margin-top:.25rem;color:${C.muted}}`,
  `.go{display:flex;align-items:center;justify-content:center;height:2.5rem;margin:.75rem 0 0;border-radius:.875rem;background:${C.primary};color:${C.onPrimary};font-size:.875rem;font-weight:500;text-decoration:none;box-shadow:0 1px 2px rgba(14,70,35,.2);transition:background-color .15s ease}`,
  `.go:hover{background:${C.primaryHover}}`,
  `.go:focus-visible{outline:2px solid ${C.ring};outline-offset:2px}`,
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
  const granted = [...MAIL_PERMISSIONS, ...AREA_PERMISSIONS.filter((area) => p.areas?.has(area) ?? false)];
  const permissions = granted
    .map((key) => `<li><span class="tick" aria-hidden="true"></span><span>${escapeHtml(t.permissions[key])}</span></li>`)
    .join("\n");
  const [withContacts, withCalendars] = AREA_PERMISSIONS.map((area) => p.areas?.has(area) ?? false);
  const never =
    withContacts || withCalendars
      ? t.neverWithAreas(t.gone[withContacts && withCalendars ? "both" : withContacts ? "contacts" : "calendars"])
      : t.never;
  const client = escapeHtml(p.clientName);
  const host = escapeHtml(p.redirectHost);
  const email = escapeHtml(p.email);
  const body = `<p class="sub">${t.lead(client, host)}</p>
<p class="mailbox">${email}</p>
<p class="may" id="may">${escapeHtml(t.may)}</p>
<ul class="perms" aria-labelledby="may">
${permissions}
</ul>
<p class="never">${escapeHtml(never)}</p>
<p class="caution">${escapeHtml(t.caution)}</p>
<form method="post" action="/approve">
<input type="hidden" name="h" value="${escapeHtml(p.handle)}">
<button type="submit" name="decision" value="allow">${escapeHtml(t.allow)}</button>
<button type="submit" name="decision" value="deny">${escapeHtml(t.deny)}</button>
</form>
<p class="note">${t.wrongMailbox(email)}</p>`;
  return htmlResponse(p.lang, t.title, body, 200);
}

/**
 * The page before the sign-in. `continueUrl` is the mail server's sign-in address this worker
 * built for the request; it is the only address on any page that leaves this origin.
 */
export function renderIntroPage(p: {
  lang: PageLanguage;
  clientName: string;
  redirectHost: string;
  mailHost: string;
  continueUrl: string;
}): Response {
  const t = INTRO_COPY[p.lang];
  const body = `<p class="sub">${t.lead(escapeHtml(p.clientName), escapeHtml(p.redirectHost))}</p>
<ol class="steps">
<li><strong>${escapeHtml(t.signIn)}</strong>${escapeHtml(t.signInText(p.mailHost))}<span class="hint">${escapeHtml(THEME.signInHint[p.lang])}</span></li>
<li><strong>${escapeHtml(t.confirm)}</strong>${escapeHtml(t.confirmText)}</li>
</ol>
<p class="never">${escapeHtml(t.password)}</p>
<p class="caution">${escapeHtml(t.caution)}</p>
<a class="go" href="${escapeHtml(p.continueUrl)}">${escapeHtml(t.go)}</a>`;
  return htmlResponse(p.lang, APPROVAL_COPY[p.lang].title, body, 200);
}

export function renderMessagePage(p: { lang: PageLanguage; kind: MessageKind; status: number }): Response {
  const text = escapeHtml(MESSAGE_COPY[p.kind][p.lang]);
  return htmlResponse(p.lang, APPROVAL_COPY[p.lang].title, `<p class="sub">${text}</p>`, p.status);
}
