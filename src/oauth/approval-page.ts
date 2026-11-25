/**
 * The HTML this worker shows in the browser: our own approval page ("Connect mailbox X to tool
 * Y?") and the fixed message pages. Client name and host are client-supplied, so every
 * interpolated value is escaped. No page ever shows an error detail or upstream text.
 */

export type PageLanguage = "de" | "en";
export type MessageKind = "refused" | "failed" | "expired";

/** No `form-action`: browsers apply it to the redirect back to the AI tool after the POST. */
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
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
    lead: (client: string, host: string, email: string) =>
      `${client} (${host}) wants to read, search and send email for ${email}.`,
    scope:
      "It will be able to read and search your mail, save drafts and send mail in your name (at most 50 messages per day). It cannot delete mail.",
    wrongMailbox: (email: string) => `Not ${email}? Choose Deny, sign out of your mailbox and try again.`,
    caution: "Only allow this if you started the connection yourself just now.",
    allow: "Allow",
    deny: "Deny",
  },
  de: {
    title: "Postfach verbinden",
    lead: (client: string, host: string, email: string) =>
      `${client} (${host}) möchte für ${email} E-Mails lesen, durchsuchen und senden.`,
    scope:
      "Die Anwendung kann Ihre E-Mails lesen und durchsuchen, Entwürfe speichern und in Ihrem Namen senden (höchstens 50 Nachrichten pro Tag). Löschen kann sie nichts.",
    wrongMailbox: (email: string) =>
      `Nicht ${email}? Wählen Sie „Ablehnen“, melden Sie sich im Postfach ab und versuchen Sie es erneut.`,
    caution: "Erlauben Sie das nur, wenn Sie die Verbindung gerade selbst gestartet haben.",
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
    de: "Die Verbindung konnte nicht abgeschlossen werden. Bitte starten Sie erneut in Ihrem KI-Werkzeug.",
  },
  expired: {
    en: "This request has expired. Please start again from your AI tool.",
    de: "Diese Anfrage ist abgelaufen. Bitte starten Sie erneut in Ihrem KI-Werkzeug.",
  },
};

const STYLE =
  "body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}" +
  "h1{font-size:1.4rem}.lead{font-size:1.1rem}.caution{font-weight:600}form{display:flex;gap:.75rem;margin-top:1.5rem}" +
  "button{font:inherit;padding:.5rem 1.25rem;border-radius:.375rem;border:1px solid #888;background:#fff;cursor:pointer}" +
  "button[value=allow]{background:#1a1a1a;color:#fff;border-color:#1a1a1a}";

/** `body` is trusted markup; every value in it must already be escaped. */
function htmlResponse(lang: PageLanguage, title: string, body: string, status: number): Response {
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
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
}): Response {
  const t = APPROVAL_COPY[p.lang];
  const client = escapeHtml(p.clientName);
  const host = escapeHtml(p.redirectHost);
  const email = escapeHtml(p.email);
  const body = `<h1>${escapeHtml(t.title)}</h1>
<p class="lead">${t.lead(client, host, email)}</p>
<p>${escapeHtml(t.scope)}</p>
<p>${t.wrongMailbox(email)}</p>
<p class="caution">${escapeHtml(t.caution)}</p>
<form method="post" action="/approve">
<input type="hidden" name="h" value="${escapeHtml(p.handle)}">
<button type="submit" name="decision" value="allow">${escapeHtml(t.allow)}</button>
<button type="submit" name="decision" value="deny">${escapeHtml(t.deny)}</button>
</form>`;
  return htmlResponse(p.lang, t.title, body, 200);
}

export function renderMessagePage(p: { lang: PageLanguage; kind: MessageKind; status: number }): Response {
  const text = escapeHtml(MESSAGE_COPY[p.kind][p.lang]);
  return htmlResponse(p.lang, APPROVAL_COPY[p.lang].title, `<p>${text}</p>`, p.status);
}
