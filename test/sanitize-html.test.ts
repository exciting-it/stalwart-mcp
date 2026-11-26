import { describe, expect, it } from "vitest";
import { isCanonicalHtml, safeHref, sanitizeHtml } from "../src/content/sanitize-html";

/** Removed with their content. */
const DROPPED = [
  "script", "style", "iframe", "frame", "frameset", "object", "applet", "form", "button", "select",
  "option", "textarea", "svg", "math", "head", "title", "noscript", "template", "audio", "video",
  "picture", "canvas", "map",
];

/** Dropped elements whose content is not markup (raw text, escapable raw text, noscript). */
const RAW_TEXT = new Set(["script", "style", "iframe", "textarea", "title", "noscript"]);

/** Removed too; they have no content (void elements), so what follows them is not theirs. */
const DROPPED_VOID = ["embed", "input", "link", "meta", "base", "source", "track", "img", "area"];

const KEPT = [
  "p", "div", "span", "b", "strong", "i", "em", "u", "s", "sub", "sup", "a", "ul", "ol", "li",
  "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td",
];

/** [input, expected output]: every case is also checked for idempotence below. */
const CASES: [string, string][] = [
  // Removed elements go with their content.
  ...DROPPED.map((tag): [string, string] => [`a<${tag}>SECRET</${tag}>b`, "ab"]),
  // An unclosed dropped element runs to the end. Inside raw text (script, style, ...) the `</p>`
  // is text and goes with it; elsewhere it still ends the paragraph.
  ...DROPPED.map((tag): [string, string] => [
    `<p>a<${tag} src="x" onerror="alert(1)">b</p>`,
    RAW_TEXT.has(tag) ? "<p>a" : "<p>a</p>",
  ]),
  ...DROPPED_VOID.map((tag): [string, string] => [`<p>a<${tag} src="x" srcset="y 1x" onerror="alert(1)">b</p>`, "<p>ab</p>"]),
  ...DROPPED_VOID.map((tag): [string, string] => [`a<${tag}/>b`, "ab"]),
  // Kept elements stay, without attributes.
  ...KEPT.filter((t) => t !== "a").map((tag): [string, string] => [`<${tag} id="x">t</${tag}>`, `<${tag}>t</${tag}>`]),
  ["a<br>b<hr>c", "a<br>b<hr>c"],
  // Any other element: tag dropped, content kept.
  ["<custom-el>kept</custom-el>", "kept"],
  ["<font color=red>red</font><center>c</center><body><html>x</html></body>", "redcx"],
  ["<marquee onstart=alert(1)>m</marquee>", "m"],
  // Attributes stripped.
  ['<p onclick="alert(1)" style="color:red" class="c" id="i">t</p>', "<p>t</p>"],
  ['<div src="x" srcset="y 1x" data-x="z" title="t">t</div>', "<div>t</div>"],
  ['<span ONCLICK="x" Style="y">t</span>', "<span>t</span>"],
  ['<td colspan="2" rowspan="0010" style="x">c</td><th colspan="1001">h</th><td colspan="0">z</td>', '<td colspan="2" rowspan="10">c</td><th>h</th><td>z</td>'],
  ['<td colspan="2px">c</td><td colspan=" 2">d</td><td rowspan="-1">e</td>', "<td>c</td><td>d</td><td>e</td>"],
  // Links.
  ['<a href="https://example.org/a?b=c#d">x</a>', '<a href="https://example.org/a?b=c#d">x</a>'],
  ['<a href="https://example.org/?a=1&amp;b=2">x</a>', '<a href="https://example.org/?a=1&amp;b=2">x</a>'],
  ['<a href="HTTPS://EXAMPLE.ORG">x</a>', '<a href="https://example.org/">x</a>'],
  ['<a href="http://example.org/">x</a>', '<a href="http://example.org/">x</a>'],
  ['<a href="  https://example.org/  ">x</a>', '<a href="https://example.org/">x</a>'],
  ['<a href="mailto:someone@example.org?subject=Hi there">x</a>', '<a href="mailto:someone@example.org?subject=Hi%20there">x</a>'],
  ['<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="JaVaScRiPt:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="java\nscript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="java\tscript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href=" javascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="\u0001javascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="\u0000https://example.org/">x</a>', "<a>x</a>"],
  ['<a href="ht\ntps://example.org/">x</a>', "<a>x</a>"],
  ['<a href="https://exa\tmple.org/">x</a>', "<a>x</a>"],
  ['<a href="data:text/html,<script>alert(1)</script>">x</a>', "<a>x</a>"],
  ['<a href="vbscript:msgbox(1)">x</a>', "<a>x</a>"],
  ['<a href="file:///etc/passwd">x</a>', "<a>x</a>"],
  ['<a href="//evil.example">x</a>', "<a>x</a>"],
  ['<a href="/path">x</a>', "<a>x</a>"],
  ['<a href="https://user:pass@example.org">x</a>', "<a>x</a>"],
  ['<a href="https://user@example.org">x</a>', "<a>x</a>"],
  ['<a href="&#106;avascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="&#x6A;avascript:alert(1)">x</a>', "<a>x</a>"],
  ['<a href="javascript&colon;alert(1)">x</a>', "<a>x</a>"],
  ['<a href="https:&#x2F;&#x2F;example.org/">x</a>', '<a href="https://example.org/">x</a>'],
  ['<a href="https://ok.example/" onclick="x" target="_blank">x</a>', '<a href="https://ok.example/">x</a>'],
  ['<a href="javascript:x" href="https://ok.example/">x</a>', "<a>x</a>"],
  ['<a href="mailto:&quot;&lt;b&gt;&quot;@x.example">x</a>', '<a href="mailto:&quot;&lt;b&gt;&quot;@x.example">x</a>'],
  ['<a>no href</a>', "<a>no href</a>"],
  // Comments, doctype, processing instructions, CDATA.
  ["<!DOCTYPE html><p>x</p>", "<p>x</p>"],
  ['<!doctype html PUBLIC "-//W3C//DTD HTML 4.01//EN" "x>y"><p>x</p>', 'y"&gt;<p>x</p>'],
  ["<p>a<!-- hidden -->b</p>", "<p>ab</p>"],
  ["<!--><script>alert(1)</script>-->", "--&gt;"],
  ["<!---><script>alert(1)</script>-->", "--&gt;"],
  ["<!-- <script>alert(1)</script> -->x", "x"],
  ["<!-- unclosed comment <script>alert(1)</script>", ""],
  ['<?xml version="1.0"?><p>y</p>', "<p>y</p>"],
  // Outside svg and math, CDATA is a bogus comment that ends at the first ">", as in a browser.
  ["<![CDATA[<script>alert(1)</script>]]><p>c</p>", "alert(1)]]&gt;<p>c</p>"],
  ["<![CDATA[x]]><p>c</p>", "<p>c</p>"],
  // Unclosed and nested tags, upper case.
  ["<b>bold<i>both", "<b>bold<i>both"],
  ["<p>x</p class=y>", "<p>x</p>"],
  ['</p title="<img src=x onerror=alert(1)>">', "</p>"],
  ["</br>", ""],
  ["</nope>x</>", "x"],
  ["<b>x<img src=x onerror=alert(1) ", "<b>x"],
  ['<p title="unclosed', "<p>"],
  ["<b>x</b", "<b>x"],
  ["<P CLASS=a>up</P>", "<p>up</p>"],
  ["<SCRIPT>alert(1)</SCRIPT>x", "x"],
  ["<script/>alert(1)</script>x", "x"],
  ["<script>alert(1)", ""],
  ["<ul><li>a<li>b</ul>", "<ul><li>a<li>b</ul>"],
  ["<div><div><div>deep</div></div></div>", "<div><div><div>deep</div></div></div>"],
  // Tricks.
  ["<svg><script>alert(1)</script></svg>after", "after"],
  ["<svg><a href='javascript:x'>s</a></svg>after", "after"],
  ["<math><mi xlink:href='javascript:x'>m</mi></math>after", "after"],
  ["<table><style>td{}</style><tr><td>c</td></tr></table>", "<table><tr><td>c</td></tr></table>"],
  ['<a href="https://a.example/"><a href="https://b.example/">in</a></a>', '<a href="https://a.example/"><a href="https://b.example/">in</a></a>'],
  ["<<script></script>img src=x onerror=alert(1)>", "&lt;img src=x onerror=alert(1)&gt;"],
  ["<scr<script></script>ipt>alert(1)</script>", "ipt&gt;alert(1)"],
  ["<xmp><img src=x onerror=1></xmp>", "&lt;img src=x onerror=1&gt;"],
  ["<plaintext><b>x</b>", "&lt;b&gt;x&lt;/b&gt;"],
  ["a < b > c &amp; d &lt;e&gt;", "a &lt; b &gt; c &amp; d &lt;e&gt;"],
  ["<noscript><p>x</p></noscript>y", "y"],
  ["<textarea><script>alert(1)</script></textarea>w", "w"],
  ["<form><p>inside an unclosed form", ""],
  ["", ""],
];

describe("sanitizeHtml", () => {
  it.each(CASES)("%j", async (input, expected) => {
    expect(await sanitizeHtml(input)).toBe(expected);
  });

  it("is stable: sanitizing the output again changes nothing", async () => {
    for (const [input] of CASES) {
      const once = await sanitizeHtml(input);
      expect(once, input).not.toBeNull();
      expect(await sanitizeHtml(once!), input).toBe(once);
    }
  });

  it("keeps a formatted message as it is", async () => {
    const html =
      '<h1>Report</h1><p>Hello <b>Bob</b>, <em>see</em> <a href="https://example.org/r">the report</a>.</p>' +
      "<ul><li>one</li><li>two</li></ul><table><thead><tr><th>k</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>" +
      "<blockquote>q</blockquote><pre><code>x = 1</code></pre>";
    expect(await sanitizeHtml(html)).toBe(html);
  });

  it("leaves no markup of a removed element and no handler or script URL in any tag", async () => {
    for (const [input] of CASES) {
      const out = (await sanitizeHtml(input)) ?? "";
      expect(out, input).not.toMatch(/<\s*(script|style|iframe|img|svg|math|object|embed|form|input|base|meta|link)/i);
      // Inside a tag; as escaped text ("&lt;img onerror=...") it is only shown.
      expect(out, input).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
      expect(out, input).not.toMatch(/<[^>]*(java|vb)script:/i);
      expect(out, input).not.toMatch(/<[^>]*\s(style|class|id|src|srcset)\s*=/i);
    }
  });
});

describe("sanitizeHtml refuses", () => {
  it.each(["<p><select>b</p><style>x</style>"])(
    "markup the streaming parser cannot place: %j",
    async (input) => {
      expect(await sanitizeHtml(input)).toBeNull();
    },
  );
});

describe("safeHref", () => {
  it("keeps absolute http, https and mailto URLs only", () => {
    expect(safeHref("https://example.org/a?b=c#d")).toBe("https://example.org/a?b=c#d");
    expect(safeHref("mailto:x@example.org")).toBe("mailto:x@example.org");
    for (const bad of ["javascript:x", "ftp://example.org/", "https://u:p@example.org/", "//example.org", "x", "https://"]) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });
});

describe("review round 1: the reported bypasses", () => {
  it("C1: an end tag with an =-prefixed attribute hides nothing", async () => {
    expect(await sanitizeHtml('</p =="><img src=x onerror=alert(1)>">')).toBe("</p>");
    expect(await sanitizeHtml('<p>Hello</p =="><img src=https://t.example/p.gif onerror=alert(1)>...">')).toBe("<p>Hello</p>");
    // With a quoted src the attribute value of the end tag ends earlier, as in a browser.
    expect(await sanitizeHtml('<p>Hello</p =="><img src="https://t.example/p.gif" onerror=alert(1)>...">')).toBe('<p>Hello</p>..."&gt;');
    expect(await sanitizeHtml('<b>x</b =="><script>alert(1)</script>">')).toBe("<b>x</b>");
  });

  it("C2: an attribute the rewriter cannot address refuses the HTML", async () => {
    for (const input of [
      '<p =onclick="alert(1)">y</p>',
      '<p =style="color:red">y</p>',
      '<a =href="javascript:alert(1)" href="https://example.org/">y</a>',
      '<td =colspan="5" colspan=3>y</td>',
      '<p =a="</p">" c=\'<p =d="\'><img src=x onerror=alert(1)>">',
      '<br =a="x">',
    ]) {
      expect(await sanitizeHtml(input), input).toBeNull();
    }
  });

  it("refuses an element with more than 50 attributes; 50 are fine", async () => {
    const attrs = (n: number) => Array.from({ length: n }, (_, i) => ` a${i}="x"`).join("");
    expect(await sanitizeHtml(`<p${attrs(50)}>y</p>`)).toBe("<p>y</p>");
    expect(await sanitizeHtml(`<p${attrs(51)}>y</p>`)).toBeNull();
    expect(await sanitizeHtml(`<x-unknown${attrs(51)}>y</x-unknown>`)).toBeNull();
  });

  it("input that contains the old end marker keeps its content and is stable", async () => {
    for (const input of [
      `<plaintext>hello<x-end "'><!--x-end-->`,
      `hello&lt;x-end "'&gt;&lt;!--x-end--&gt;`,
      `a<x-end "'><!--x-end-->b`,
    ]) {
      const once = await sanitizeHtml(input);
      expect(once, input).not.toBeNull();
      expect(once, input).toMatch(/hello|ab/);
      expect(await sanitizeHtml(once!), input).toBe(once);
    }
    expect(await sanitizeHtml(`<plaintext>hello<x-end "'><!--x-end-->`)).toBe(`hello&lt;x-end "'&gt;&lt;!--x-end--&gt;`);
    expect(await sanitizeHtml(`hello&lt;x-end "'&gt;&lt;!--x-end--&gt;`)).toBe(`hello&lt;x-end "'&gt;&lt;!--x-end--&gt;`);
  });

  it("writes start tags in the canonical form", async () => {
    expect(await sanitizeHtml("<P >a</P ><p/>b<BR/><hr />")).toBe("<p>a</p><p>b<br><hr>");
  });
});

describe("isCanonicalHtml", () => {
  it.each([
    "",
    "text & more &amp; &lt;b&gt;",
    "<p>a</p><br><hr>",
    '<a href="https://example.org/a?b=1&amp;c=2#d">x</a>',
    '<a href="mailto:x@example.org">x</a>',
    "<a>x</a>",
    '<td colspan="2" rowspan="10">c</td><th rowspan="1000">h</th>',
    "<h1>t</h1><ul><li>a<li>b</ul>",
    "</p></div>",
  ])("accepts %j", (html) => expect(isCanonicalHtml(html)).toBe(true));

  it.each([
    "a > b",
    "a < b",
    "<P>a</P>",
    "<p >a</p>",
    "<p/>",
    "<br/>",
    "</br>",
    "</hr>",
    "<img src=x>",
    "<script>x</script>",
    "</script>",
    "<x-end>",
    '<p class="c">a</p>',
    '<p =a="x">a</p>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="https://example.org">x</a>',
    '<a href="https://example.org/" href="https://example.org/">x</a>',
    "<a href='https://example.org/'>x</a>",
    '<a href="https://example.org/&colon;">x</a>',
    '<a href="https://u:p@example.org/">x</a>',
    '<a title="x">x</a>',
    '<td colspan="0">c</td>',
    '<td colspan="1001">c</td>',
    '<td colspan="02">c</td>',
    '<td colspan="2" colspan="3">c</td>',
    '<td style="x">c</td>',
    '<p colspan="2">c</p>',
    "</p class=x>",
    "</p =\"><img src=x onerror=alert(1)>\">",
    "<!-- c -->",
    "<!doctype html>",
    "<",
    "</",
    "<p",
  ])("refuses %j", (html) => expect(isCanonicalHtml(html)).toBe(false));

  it("is linear: 200,000 characters of tags are checked quickly", () => {
    const html = "<p><b>x</b></p>".repeat(14_000);
    const t = Date.now();
    expect(isCanonicalHtml(html)).toBe(true);
    expect(isCanonicalHtml(html + "<")).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

/** Hostile inputs of the classes in the review; each is null, or canonical, stable and harmless. */
const HOSTILE = [
  '</p =="><img src=x onerror=alert(1)>">',
  '</p ="a></b title="><img src=x onerror=alert(1)>">',
  '</p =a="b><img src=x onerror=alert(1)>">',
  '</x =="><img src=x onerror=alert(1)>">',
  '</br =="><img src=x onerror=alert(1)>">',
  '</style =="><img src=x onerror=alert(1)>">',
  '</P =="><img src=x onerror=alert(1)>">',
  '<p =onclick="alert(1)">y</p>',
  '<p ==>y',
  '<p/=a="x">y',
  '<p =a="</p">" c=\'<p =d="\'><img src=x onerror=alert(1)>">',
  '<a href="https://ok.example/" href="javascript:alert(1)">x</a>',
  '<a HREF="javascript:alert(1)" href="https://ok.example/">x</a>',
  '<p onclick=alert(1) onclick=alert(2) ONCLICK=alert(3)>y</p>',
  '<p title="a>b" onclick="x">y</p>',
  "<p title='<img src=x onerror=alert(1)>'>y</p>",
  '<p "onclick"="alert(1)">y</p>',
  "<p 'x'=y>y</p>",
  "<p <img src=x onerror=alert(1)>>y</p>",
  "<p</p><img src=x onerror=alert(1)>",
  "<xmp></xmp><img src=x onerror=alert(1)></xmp>",
  "<noembed><img src=x onerror=alert(1)></noembed>",
  "<noframes><img src=x onerror=alert(1)></noframes>",
  "<listing><img src=x onerror=alert(1)></listing>",
  "<iframe><img src=x onerror=alert(1)></iframe>x",
  "<title></title><img src=x onerror=alert(1)>",
  "<textarea></textarea ><img src=x onerror=alert(1)>",
  "<script><!--<script></script><img src=x onerror=alert(1)>--></script>",
  "<style></style ><img src=x onerror=alert(1)>",
  "<svg><p><style><img src=x onerror=alert(1)></style></p></svg>",
  "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
  "<svg></p><style><a id=\"</style><img src=1 onerror=alert(1)>\">",
  "<svg><![CDATA[><img src=x onerror=alert(1)>]]></svg>",
  "<![CDATA[><img src=x onerror=alert(1)>]]>",
  "<math><annotation-xml encoding=text/html><img src=x onerror=alert(1)></annotation-xml></math>",
  "<b>x<img src=x onerror=alert(1) ",
  '<p title="unclosed',
  "<p title='unclosed",
  "<!--",
  "<!-- <img src=x onerror=alert(1)>",
  "</p",
  "</p title=\"",
  "<!doctype html \"",
  `<x-end "'><!--x-end-->`,
  `<x-end "'><!--x-end--><img src=x onerror=alert(1)>`,
  "&lt;img src=x onerror=alert(1)&gt;",
  "&#60;img src=x onerror=alert(1)&#62;",
  "<a href=\"&#x6A;avascript:alert(1)\">x</a>",
  "<a href=\"https://ok.example/&colon;x\">x</a>",
  "<!x-doctype><img src=x onerror=alert(1)>",
  "<p>a</p class=\"x\" =\"<img>\">",
  "<td colspan=\"2\" colspan=\"3\" rowspan=\"4\">x</td>",
];

function harmless(out: string): void {
  expect(isCanonicalHtml(out), out).toBe(true);
  expect(out).not.toMatch(/<(?!\/?(?:p|br|div|span|b|strong|i|em|u|s|sub|sup|a|ul|ol|li|blockquote|pre|code|h[1-6]|hr|table|thead|tbody|tfoot|tr|th|td)[ >])/);
}

describe("hostile inputs", () => {
  it(`has at least 40 cases (${HOSTILE.length})`, () => expect(HOSTILE.length).toBeGreaterThanOrEqual(40));

  it.each(HOSTILE)("%j is refused, or canonical, harmless and stable", async (input) => {
    const out = await sanitizeHtml(input);
    if (out === null) return;
    harmless(out);
    expect(await sanitizeHtml(out)).toBe(out);
  });
});

describe("random markup", () => {
  const ALPHABET = ["<", ">", "/", "=", '"', "'", "!", "-", " ", "p", "a", "img", "script", "href", "onerror", "javascript:", "https://x.example/"];

  /** Small deterministic generator (mulberry32), so a failure can be repeated. */
  function rng(seed: number): () => number {
    let t = seed;
    return () => {
      t = (t + 0x6d2b79f5) | 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("every non-null output of 3,000 random strings is canonical and stable", async () => {
    const next = rng(20261126);
    for (let n = 0; n < 3000; n++) {
      const length = 1 + Math.floor(next() * 40);
      let input = "";
      for (let k = 0; k < length; k++) input += ALPHABET[Math.floor(next() * ALPHABET.length)];
      const out = await sanitizeHtml(input);
      if (out === null) continue;
      expect(isCanonicalHtml(out), input).toBe(true);
      expect(await sanitizeHtml(out), input).toBe(out);
    }
  });
});
