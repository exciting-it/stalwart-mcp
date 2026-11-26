/**
 * Allow-list sanitizing for outgoing HTML (`send_mail`, `create_draft`). The HTML is written by
 * an AI tool, possibly steered by a mail it read, and leaves under the mailbox's name, so only
 * text formatting, links, lists, headings and tables survive. Parsing is the runtime's
 * `HTMLRewriter` (an HTML tokenizer that follows the HTML standard); the rules:
 *
 * - a kept element (`KEPT`) is written anew in canonical form: `<name>`, or with its checked
 *   attributes (`href` on `a`, `colspan` / `rowspan` on `th` and `td`); its original start and end
 *   tags go, so nothing of their attributes can stay;
 * - dropped elements (`DROPPED`) go with everything inside them;
 * - any other element is unwrapped: the tag goes, its content stays;
 * - comments, processing instructions, CDATA and the doctype are removed;
 * - text is re-escaped (`<` and `>`), so markup can never form again out of the pieces that are
 *   left once something was removed between them;
 * - end tags the rewriter passes through as written become `</name>` or go.
 *
 * The last step does not trust any of that: `isCanonicalHtml` checks the output against the
 * exact form the steps above write, and anything else refuses the HTML as a whole (`null`).
 * HTML the rewriter cannot parse, an element with an attribute the rewriter cannot address, and
 * an element with more than `MAX_ATTRIBUTES` attributes are refused the same way.
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

/** Kept elements that have no end tag; `</br>` would make a line break. */
const VOID = new Set(["br", "hr"]);

/** More attributes on one element refuse the HTML before any work per attribute. */
const MAX_ATTRIBUTES = 50;

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** C0 controls and DEL anywhere in an `href` refuse it. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

const escapeText = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The checked link target of an attribute value as written in the HTML (entities decoded once),
 * or null: an absolute http, https or mailto URL without credentials.
 */
export function safeHref(raw: string): string | null {
  return checkedUrl(decodeEntities(raw).trim());
}

/** The same check on a value that is already decoded: nothing in it is read as an entity. */
function checkedUrl(value: string): string | null {
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

/** `colspan` / `rowspan`: digits only, 1 to 1000, written without leading zeros. */
function span(raw: string): string | null {
  if (!/^[0-9]{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 1000 ? String(n) : null;
}

/**
 * The canonical start tag of a kept element, from its checked attributes only. An `href` that
 * holds the end marker was left unfinished by the input and swallowed the suffix: it is left
 * out, so the random marker never reaches the output and the same input gives the same result.
 */
function startTag(e: Element, marker: string): string {
  const name = e.tagName;
  if (name === "a") {
    const href = e.getAttribute("href");
    const target = href === null || href.includes(marker) ? null : safeHref(href);
    return target === null ? "<a>" : `<a href="${escapeAttribute(target)}">`;
  }
  if (name === "th" || name === "td") {
    let attributes = "";
    for (const attribute of ["colspan", "rowspan"]) {
      const raw = e.getAttribute(attribute);
      const value = raw === null ? null : span(raw);
      if (value !== null) attributes += ` ${attribute}="${value}"`;
    }
    return `<${name}${attributes}>`;
  }
  return `<${name}>`;
}

/**
 * True when the element's attributes can be read and removed one by one: at most
 * `MAX_ATTRIBUTES`, each addressable by its name. The rewriter lists a name that starts with
 * `=` but cannot find it by that name; such an element is refused.
 */
function attributesInHand(e: Element): boolean {
  const names: string[] = [];
  for (const [name] of e.attributes) {
    if (names.length === MAX_ATTRIBUTES) return false;
    names.push(name ?? "");
  }
  return names.every((name) => e.hasAttribute(name));
}

/** Random per call, so no input can contain it. */
function endMarker(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The sanitized HTML, or null when it is refused as a whole: the rewriter cannot parse it (its
 * streaming parser stops at markup it cannot place without a full tree, such as a `<style>`
 * after an unclosed `<select>`), an element has attributes the rewriter cannot address or too
 * many of them, or the result is not in the canonical form (`isCanonicalHtml`).
 */
export async function sanitizeHtml(html: string): Promise<string | null> {
  // The rewriter passes markup that the input leaves unfinished at its end (`<img src=x
  // onerror=...` without `>`) through as it is, where a later concatenation could complete it.
  // This suffix finishes any open tag, quoted attribute, comment or bogus comment: `<x-... "'>`
  // closes a tag (the quotes end an open attribute value), the comment closes a comment. In text
  // the first part is an unknown element (unwrapped, so nothing) and the second a comment
  // (removed). Inside `plaintext` it stays text and is cut off. Its name is random per call.
  const marker = endMarker();
  const suffix = `<x-end-${marker} "'><!--x-end-${marker}-->`;
  // The rewriter cannot remove a doctype. `<!x-doctype ...>` is a bogus comment instead: it ends
  // at the same `>` a doctype ends at, and comments are removed.
  const input = html.replace(/<!doctype/gi, "<!x-doctype") + suffix;
  let refused = false;
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(e) {
        if (!attributesInHand(e)) {
          refused = true;
          return;
        }
        if (DROPPED.has(e.tagName)) {
          e.remove();
          return;
        }
        if (!KEPT.has(e.tagName)) {
          e.removeAndKeepContent();
          return;
        }
        // The original tags go; the kept element is written anew from its checked attributes.
        const name = e.tagName;
        const start = startTag(e, marker);
        e.removeAndKeepContent();
        e.before(start, { html: true });
        if (!VOID.has(name)) e.onEndTag((end) => void end.before(`</${name}>`, { html: true }));
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
  if (refused) return null;
  const leftover = escapeText(suffix);
  const result = normalizeEndTags(out.endsWith(leftover) ? out.slice(0, -leftover.length) : out);
  return result !== null && isCanonicalHtml(result) ? result : null;
}

/**
 * The rewriter passes end tags it cannot match to a start tag through as written
 * (`</p class=x>`); this writes them back as `</name>` for a kept element with content and drops
 * the others. Null when a tag does not end; `isCanonicalHtml` checks the result in any case.
 */
function normalizeEndTags(html: string): string | null {
  const parts: string[] = [];
  let from = 0;
  let at = html.indexOf("</");
  while (at !== -1) {
    parts.push(html.slice(from, at));
    const tag = parseTag(html, at);
    if (tag === null) return null;
    if (KEPT.has(tag.name) && !VOID.has(tag.name)) parts.push(`</${tag.name}>`);
    from = tag.end;
    at = html.indexOf("</", from);
  }
  parts.push(html.slice(from));
  return parts.join("");
}

/**
 * One token of the canonical output, anchored where the last one ended: text without `<` or
 * `>`, a start tag `<name>` with double-quoted lower-case attributes whose values hold no `"`,
 * `<` or `>`, or an end tag `</name>`. The classes do not overlap, so it runs in linear time.
 */
const TOKEN = /([^<>]+)|<([a-z0-9]+)((?: [a-z]+="[^"<>]*")*)>|<\/([a-z0-9]+)>/y;
const ATTRIBUTE = / ([a-z]+)="([^"<>]*)"/g;

/** The checked attributes of one canonical start tag, or false. */
function canonicalAttributes(name: string, attributes: string): boolean {
  if (attributes === "") return true;
  const seen = new Set<string>();
  for (const [, attribute = "", value = ""] of attributes.matchAll(ATTRIBUTE)) {
    if (seen.has(attribute)) return false;
    seen.add(attribute);
    if (name === "a" && attribute === "href") {
      const decoded = decodeEntities(value);
      // Decoded once, as a reader of the attribute does; a second decoding would misread a
      // literal `&amp;` in the URL.
      if (escapeAttribute(decoded) !== value || checkedUrl(decoded) !== decoded) return false;
    } else if ((name === "th" || name === "td") && (attribute === "colspan" || attribute === "rowspan")) {
      if (span(value) !== value) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * The final check, independent of how the HTML was made: true only when `html` is a sequence of
 * text without `<` and `>`, canonical start tags of kept elements (`<name>`, `<a href="...">`
 * with a checked, normalized URL, `<th>` / `<td>` with checked `colspan` / `rowspan`, each at
 * most once) and end tags `</name>` of kept elements that have content.
 */
export function isCanonicalHtml(html: string): boolean {
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < html.length) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(html);
    if (m === null) return false;
    at = TOKEN.lastIndex;
    const [, text, start, attributes = "", end] = m;
    if (text !== undefined) continue;
    if (start !== undefined) {
      if (!KEPT.has(start) || !canonicalAttributes(start, attributes)) return false;
    } else if (end === undefined || !KEPT.has(end) || VOID.has(end)) {
      return false;
    }
  }
  return true;
}
