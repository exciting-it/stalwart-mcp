import { describe, expect, it } from "vitest";
import { cleanText, htmlToText } from "../src/content/sanitize";

describe("cleanText", () => {
  it("removes control, zero-width and bidi characters but keeps newlines and tabs", () =>
    expect(cleanText("a\u0000b\u200Bc\u202Ed\u0007\n\te\u009F", 100).text).toBe("abcd\n\te"));

  it("cuts at maxChars and says so", () =>
    expect(cleanText("x".repeat(30), 20)).toEqual({ text: "x".repeat(20), truncated: true }));

  it("does not flag text that fits exactly", () =>
    expect(cleanText("x".repeat(20), 20)).toEqual({ text: "x".repeat(20), truncated: false }));

  it("normalises CRLF to LF and drops a lone CR", () =>
    expect(cleanText("a\r\nb\rc", 100).text).toBe("a\nbc"));

  it("removes the word joiner range, BOM and invisible tag characters", () =>
    expect(cleanText("a\u2060b\u2069c\uFEFFd\u{E0041}e", 100).text).toBe("abcde"));

  it("never cuts a surrogate pair in half", () => {
    const r = cleanText("a😀b", 2);
    expect(r).toEqual({ text: "a", truncated: true });
  });

  it("counts the cut after removal, so hidden characters do not use up the budget", () =>
    expect(cleanText("\u200B".repeat(50) + "abc", 3)).toEqual({ text: "abc", truncated: false }));
});

describe("htmlToText", () => {
  it("drops script, style and comments with their content", () =>
    expect(htmlToText("<style>p{}</style><p>Hi</p><script>steal()</script><!-- x -->")).toBe("Hi"));

  it("drops head with its content", () =>
    expect(htmlToText("<html><head><title>T</title></head><body>Body</body></html>")).toBe("Body"));

  it("keeps link text and target, never markup", () =>
    expect(htmlToText('<a href="https://x.example/a">Click</a>')).toBe("Click <https://x.example/a>"));

  it("does not repeat a target that equals the link text", () =>
    expect(htmlToText('<a href="https://x.example/a">https://x.example/a</a>')).toBe("https://x.example/a"));

  it("drops non-http link targets and image sources", () =>
    expect(htmlToText('<a href="javascript:alert(1)">x</a><img src="https://t.example/p.gif">')).toBe("x"));

  it("keeps quoted greater-than signs inside attributes out of the text", () =>
    expect(htmlToText('<a title="a>b" href="https://x.example/">L</a>')).toBe("L <https://x.example/>"));

  it("turns br and closing block tags into newlines and collapses blank lines", () =>
    expect(htmlToText("<p>a</p><p>b<br>c</p><div></div><div></div><p>d</p>")).toBe("a\nb\nc\n\nd"));

  it("decodes entities once", () => expect(htmlToText("&lt;b&gt; &amp;amp; &#65;")).toBe("<b> &amp; A"));

  it("decodes quotes, nbsp and hex entities", () =>
    expect(htmlToText("&quot;x&quot; &#39;y&#39;&nbsp;&#x42;")).toBe("\"x\" 'y' B"));

  it("handles 2 MB of nested tags quickly", () => {
    const t0 = performance.now();
    htmlToText("<div>".repeat(200_000) + "x" + "<".repeat(500_000));
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("drops everything after an unclosed script, style or comment", () => {
    expect(htmlToText("a<script>alert(1) b")).toBe("a");
    expect(htmlToText("a<style>p{} b")).toBe("a");
    expect(htmlToText("a<!-- b")).toBe("a");
  });

  it("drops an unclosed tag to the end of input", () =>
    expect(htmlToText('a<a href="https://x.example/ b')).toBe("a"));

  it("keeps a bare less-than that does not start a tag", () =>
    expect(htmlToText("a < b and 1<2")).toBe("a < b and 1<2"));

  it("keeps escaped markup as visible text and never treats it as a tag", () =>
    expect(htmlToText("&lt;script&gt;steal()&lt;/script&gt;")).toBe("<script>steal()</script>"));

  it("matches tag names case-insensitively", () =>
    expect(htmlToText("<SCRIPT>x</ScRiPt>ok")).toBe("ok"));

  it("returns trimmed text without cutting length", () =>
    expect(htmlToText("  <p>" + "x".repeat(5000) + "</p>  ")).toBe("x".repeat(5000)));
});
