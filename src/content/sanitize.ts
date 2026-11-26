/**
 * Plain-text sanitizing for mail content. Mail is written by third parties, so everything
 * mail-derived passes through these two pure functions before it is returned.
 */

// C0 controls except \n and \t, DEL and C1 controls, zero-width and bidi controls,
// BOM and the invisible "tag" block (used to smuggle hidden ASCII).
const UNWANTED =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

export function cleanText(input: string, maxChars: number): { text: string; truncated: boolean } {
  const text = input.replace(/\r\n/g, "\n").replace(UNWANTED, "");
  if (text.length <= maxChars) return { text, truncated: false };
  let end = Math.max(0, maxChars);
  // Do not split a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "tr", "table", "blockquote", "pre", "section", "article",
  "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "hr",
]);
const DROPPED_WITH_CONTENT = new Set(["script", "style", "head"]);

const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** One pass over the text; the replacement is never rescanned, so entities decode exactly once. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower[0] !== "#") return NAMED[lower] ?? whole;
    const code = lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return code === 0xa0 ? " " : String.fromCodePoint(code);
  });
}

const isLetter = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

export interface ParsedTag {
  name: string;
  closing: boolean;
  href: string | null;
  /** Index just after the closing `>`. */
  end: number;
}

/** Parses one tag starting at `<`. Returns null when the tag never ends (caller drops the rest). */
export function parseTag(html: string, start: number): ParsedTag | null {
  let i = start + 1;
  const closing = html.charAt(i) === "/";
  if (closing) i++;
  const nameStart = i;
  while (i < html.length && !isSpace(html.charAt(i)) && html.charAt(i) !== "/" && html.charAt(i) !== ">") i++;
  const name = html.slice(nameStart, i).toLowerCase();
  let href: string | null = null;
  while (i < html.length) {
    const c = html.charAt(i);
    if (c === ">") return { name, closing, href, end: i + 1 };
    if (isSpace(c) || c === "/") {
      i++;
      continue;
    }
    const attrStart = i;
    // As in HTML: a "=" where a name starts is part of that name, not the start of a value.
    if (html.charAt(i) === "=") i++;
    while (i < html.length && !isSpace(html.charAt(i)) && html.charAt(i) !== "=" && html.charAt(i) !== ">" && html.charAt(i) !== "/") i++;
    const attr = html.slice(attrStart, i).toLowerCase();
    while (i < html.length && isSpace(html.charAt(i))) i++;
    if (html.charAt(i) !== "=") continue;
    i++;
    while (i < html.length && isSpace(html.charAt(i))) i++;
    let value: string;
    if (html.charAt(i) === '"' || html.charAt(i) === "'") {
      const close = html.indexOf(html.charAt(i), i + 1);
      if (close === -1) return null;
      value = html.slice(i + 1, close);
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < html.length && !isSpace(html.charAt(i)) && html.charAt(i) !== ">") i++;
      value = html.slice(valueStart, i);
    }
    if (attr === "href" && href === null) href = value;
  }
  return null;
}

/** Index of `</name` (case-insensitive, name must end there), or -1. Linear in the input. */
function findClosing(html: string, from: number, name: string): number {
  let p = html.indexOf("</", from);
  while (p !== -1) {
    if (html.substr(p + 2, name.length).toLowerCase() === name) {
      const after = html.charAt(p + 2 + name.length);
      if (!isLetter(after)) return p;
    }
    p = html.indexOf("</", p + 2);
  }
  return -1;
}

/** Keeps only http(s) targets and makes them safe to wrap in `<...>`. */
function linkTarget(rawHref: string): string | null {
  const href = decodeEntities(rawHref).trim();
  if (!/^https?:\/\//i.test(href)) return null;
  return href.replace(/[\u0000- \u007F-\u009F<>]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function htmlToText(html: string): string {
  const out: string[] = [];
  let link: { href: string; outStart: number } | null = null;

  const closeLink = () => {
    if (!link) return;
    const text = out.slice(link.outStart).join("").trim();
    if (text !== link.href) out.push(text === "" ? `<${link.href}>` : ` <${link.href}>`);
    link = null;
  };

  let i = 0;
  while (i < html.length) {
    if (html.charAt(i) !== "<") {
      const next = html.indexOf("<", i);
      const end = next === -1 ? html.length : next;
      out.push(decodeEntities(html.slice(i, end).replace(/[ \t\r\n\f]+/g, " ")));
      i = end;
      continue;
    }

    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }

    const c = html.charAt(i + 1);
    const startsTag =
      c !== "" && (isLetter(c) || c === "!" || c === "?" || (c === "/" && isLetter(html.charAt(i + 2))));
    if (!startsTag) {
      // A bare "<" is text; take everything up to the next "<" in one step.
      const next = html.indexOf("<", i + 1);
      const end = next === -1 ? html.length : next;
      out.push(decodeEntities(html.slice(i, end).replace(/[ \t\r\n\f]+/g, " ")));
      i = end;
      continue;
    }

    const tag = parseTag(html, i);
    if (tag === null) break;
    i = tag.end;

    if (!tag.closing && DROPPED_WITH_CONTENT.has(tag.name)) {
      const close = findClosing(html, i, tag.name);
      if (close === -1) break;
      const closeTag = parseTag(html, close);
      if (closeTag === null) break;
      i = closeTag.end;
    } else if (tag.name === "br") {
      out.push("\n");
    } else if (tag.name === "a") {
      closeLink();
      if (!tag.closing) {
        const href = tag.href === null ? null : linkTarget(tag.href);
        if (href !== null) link = { href, outStart: out.length };
      }
    } else if (tag.closing && BLOCK_TAGS.has(tag.name)) {
      out.push("\n");
    } else if (!tag.closing && (tag.name === "td" || tag.name === "th")) {
      // A cell starts apart from the one before it; the tidying below drops the space at a line's start.
      out.push(" ");
    }
  }
  closeLink();

  // Tidy: trim every line, collapse space runs, keep at most one blank line in a row.
  const lines: string[] = [];
  let blank = false;
  for (const raw of out.join("").split("\n")) {
    const line = raw.replace(/ {2,}/g, " ").trim();
    if (line === "") {
      blank = true;
      continue;
    }
    if (blank && lines.length > 0) lines.push("");
    blank = false;
    lines.push(line);
  }
  return lines.join("\n");
}
