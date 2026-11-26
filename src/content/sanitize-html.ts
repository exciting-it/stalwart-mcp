/**
 * Allow-list sanitizing for outgoing HTML (`send_mail`, `create_draft`). The HTML is written by
 * an AI tool, possibly steered by a mail it read, and leaves under the mailbox's name, so only
 * text formatting, links, lists, headings and tables survive. Parsing is the runtime's
 * `HTMLRewriter` (an HTML tokenizer that follows the HTML standard); the rules:
 *
 * - kept elements (`KEPT`) lose every attribute except a checked `href` on `a` and a checked
 *   `colspan` / `rowspan` on `th` and `td`;
 * - dropped elements (`DROPPED`) go with everything inside them;
 * - any other element is unwrapped: the tag goes, its content stays;
 * - comments, processing instructions, CDATA and the doctype are removed;
 * - text is re-escaped (`<` and `>`), so markup can never form again out of the pieces that are
 *   left once something was removed between them;
 * - end tags are written back bare (`</p>`), or dropped when they do not end a kept element.
 *
 * Sanitizing the output again changes nothing. HTML the rewriter refuses to parse is refused as
 * a whole (`null`).
 */
import { decodeEntities, parseTag } from "./sanitize";

const KEPT = new Set([
  "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "sub", "sup", "a", "ul", "ol", "li",
  "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td",
]);

const DROPPED = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input",
  "button", "select", "option", "textarea", "svg", "math", "link", "meta", "base", "head", "title",
  "noscript", "template", "audio", "video", "source", "track", "img", "picture", "canvas", "map",
  "area",
]);

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** C0 controls and DEL anywhere in an `href` refuse it. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Appended to the input and never part of the output. The rewriter passes markup that the input
 * leaves unfinished at its end (`<img src=x onerror=...` without `>`) through as it is, where a
 * later concatenation could complete it. This suffix finishes any open tag, quoted attribute,
 * comment or bogus comment: `<x-end "'>` closes a tag (the quotes end an open attribute value),
 * `<!--x-end-->` closes a comment. In text the first part is an unknown element (unwrapped, so
 * nothing) and the second a comment (removed). Inside `plaintext` it stays text and is cut off.
 */
const SUFFIX = `<x-end "'><!--x-end-->`;

const escapeText = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Kept elements that have no end tag; `</br>` would make a line break. */
const VOID = new Set(["br", "hr"]);

/** The checked link target, or null: an absolute http, https or mailto URL without credentials. */
export function safeHref(raw: string): string | null {
  const value = decodeEntities(raw).trim();
  if (hasControl(value) || !/^(?:https?|mailto):/i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.has(url.protocol) || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/** `colspan` / `rowspan`: digits only, 1 to 1000. */
function span(raw: string): string | null {
  if (!/^[0-9]{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 1000 ? String(n) : null;
}

function keep(e: Element): void {
  const kept: [string, string][] = [];
  if (e.tagName === "a") {
    const href = e.getAttribute("href");
    const target = href === null ? null : safeHref(href);
    if (target !== null) kept.push(["href", target]);
  } else if (e.tagName === "th" || e.tagName === "td") {
    for (const name of ["colspan", "rowspan"]) {
      const raw = e.getAttribute(name);
      const value = raw === null ? null : span(raw);
      if (value !== null) kept.push([name, value]);
    }
  }
  // Every attribute goes (also repeated ones); the checked ones are written back normalized.
  for (const [name] of [...e.attributes]) {
    if (name !== undefined) while (e.hasAttribute(name)) e.removeAttribute(name);
  }
  for (const [name, value] of kept) e.setAttribute(name, escapeAttribute(value));
}

/**
 * The sanitized HTML, or null when the rewriter refuses to parse it: its streaming parser stops at
 * markup it cannot place without a full tree (a `<textarea>` or `<script>` inside `<select>`,
 * for example). Such HTML is refused as a whole, never passed on.
 */
export async function sanitizeHtml(html: string): Promise<string | null> {
  // The rewriter cannot remove a doctype. `<!x-doctype ...>` is a bogus comment instead: it ends
  // at the same `>` a doctype ends at, and comments are removed.
  const input = html.replace(/<!doctype/gi, "<!x-doctype") + SUFFIX;
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(e) {
        if (DROPPED.has(e.tagName)) e.remove();
        else if (KEPT.has(e.tagName)) keep(e);
        else e.removeAndKeepContent();
      },
    })
    .onDocument({
      comments(c) {
        c.remove();
      },
      text(t) {
        if (/[<>]/.test(t.text)) t.replace(escapeText(t.text), { html: true });
      },
    });
  const response = new Response(input, { headers: { "content-type": "text/html; charset=utf-8" } });
  let out: string;
  try {
    out = await rewriter.transform(response).text();
  } catch {
    return null;
  }
  const leftover = escapeText(SUFFIX);
  return normalizeEndTags(out.endsWith(leftover) ? out.slice(0, -leftover.length) : out);
}

/**
 * The rewriter passes end tags through as written, and one without a matching start tag never
 * reaches a handler, so `</p class=x>` or `</foo title="...">` would stay. In the rewriter's
 * output every `<` starts a tag (text and attribute values are escaped, a kept start tag has
 * only checked attributes), so each `</` found here is an end tag: it becomes `</name>` for a
 * kept element with content and goes otherwise.
 */
function normalizeEndTags(html: string): string {
  const parts: string[] = [];
  let from = 0;
  let at = html.indexOf("</");
  while (at !== -1) {
    parts.push(html.slice(from, at));
    const tag = parseTag(html, at);
    if (tag === null) return parts.join("");
    if (KEPT.has(tag.name) && !VOID.has(tag.name)) parts.push(`</${tag.name}>`);
    from = tag.end;
    at = html.indexOf("</", from);
  }
  parts.push(html.slice(from));
  return parts.join("");
}
