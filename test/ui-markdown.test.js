// Renderer for the ui file view (src/ui/markdown.js). Unit tests per feature, plus the security table:
// every hostile input must come out as inert text, never as a live link, tag or handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMd, safeHref } from "../src/ui/markdown.js";

test("headings get GitHub-style ids: lowercase, punctuation dropped, spaces to -, duplicates -1/-2", () => {
  const h = renderMd("# Hello, World!\n\n## Hello, World!\n\n### Hello, World!\n\n## `code` & *Em*\n");
  assert.match(h, /<h1 id="hello-world" /);
  assert.match(h, /<h2 id="hello-world-1" /);
  assert.match(h, /<h3 id="hello-world-2" /);
  assert.match(h, /<h2 id="code--em" /);
});

test("inline: bold, italic, code (markup inside code stays literal), snake_case is not italic", () => {
  const h = renderMd("a **b** *c* _d_ `x *y* <z>` snake_case_name");
  assert.match(h, /<strong>b<\/strong>/);
  assert.match(h, /<em>c<\/em>/);
  assert.match(h, /<em>d<\/em>/);
  assert.match(h, /<code>x \*y\* &lt;z&gt;<\/code>/);
  assert.ok(h.includes("snake_case_name"));
});

test("links: external opens safely, anchor and relative stay as links", () => {
  const h = renderMd("[a](https://x.dev/p?q=1&r=2) [b](#sec) [c](docs/a_b.md)");
  assert.match(h, /<a href="https:\/\/x\.dev\/p\?q=1&amp;r=2" rel="noopener noreferrer" target="_blank">a<\/a>/);
  assert.match(h, /<a href="#sec" rel="noopener noreferrer">b<\/a>/);
  assert.match(h, /<a href="docs\/a_b\.md" rel="noopener noreferrer">c<\/a>/);
});

test("lists: bullets, numbers, wrapped item text, one nesting level", () => {
  const h = renderMd("- one\n  wrapped\n- two\n  - nested\n- three\n\n1. a\n2. b\n");
  assert.match(h, /<ul id="B1"[^>]*><li data-l="1">one wrapped<\/li><li data-l="3">two<ul><li data-l="4">nested<\/li><\/ul><\/li><li data-l="5">three<\/li><\/ul>/);
  assert.match(h, /<ol id="B7"[^>]*><li data-l="7">a<\/li><li data-l="8">b<\/li><\/ol>/);
});

test("lists: bold that spans a wrapped item line still renders", () => {
  assert.match(renderMd("- see **a very\n  long phrase** here\n"), /<li data-l="1">see <strong>a very long phrase<\/strong> here<\/li>/);
});

test("fenced code is escaped and untouched by inline rules; blockquote; hr; table", () => {
  const h = renderMd("```js\nconst a = '<b>' * 2; // **x**\n```\n\n> quoted *q*\n\n---\n\n| A | B |\n|---|:-:|\n| 1 | `x` |\n");
  assert.match(h, /<pre id="B1"[^>]*><code>const a = &#39;&lt;b&gt;&#39; \* 2; \/\/ \*\*x\*\*<\/code><\/pre>/);
  assert.match(h, /<blockquote[^>]*>quoted <em>q<\/em><\/blockquote>/);
  assert.match(h, /<div id="B7" data-l="7" class="blk rule"><hr><\/div>/);
  assert.match(h, /<th data-l="9">A<\/th><th>B<\/th>/, "header row carries its line for the gutter");
  assert.match(h, /<tr data-l="11"><td data-l="11">1<\/td><td><code>x<\/code><\/td>/, "body row too");
});

test("a table indented under a list item still renders as a table", () => {
  assert.match(renderMd("  | A | B |\n  |---|---|\n  | 1 | 2 |\n"), /<table id="B1"[^>]*><thead><tr><th data-l="1">A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr data-l="3"><td data-l="3">1<\/td><td>2<\/td>/);
});

test("highlight: only blocks overlapping [s,e] get 'on'; block ids and data-l are start lines", () => {
  const h = renderMd("# T\n\npara one\nstill one\n\npara two\n", 4, 4);
  assert.match(h, /<h1 id="t" data-l="1" class="blk">/);
  assert.match(h, /<p id="B3" data-l="3" class="blk on">/);
  assert.match(h, /<p id="B6" data-l="6" class="blk">/);
  assert.doesNotMatch(renderMd("a\n\nb\n"), /class="blk on"/, "no range, no highlight");
});

test("raw HTML shows as escaped text; a block of only HTML is dimmed, not hidden", () => {
  const h = renderMd('<p align="center">\n<img src="x.png" alt="badge">\n</p>\n\nreal text <b>x</b>');
  assert.match(h, /class="blk rawhtml"/);
  assert.ok(h.includes("&lt;img src=&quot;x.png&quot;"), "visible as text");
  assert.ok(!h.includes("<img"));
  assert.equal(h.match(/rawhtml/g)?.length, 1, "a paragraph with real text is not dimmed");
});

test("YAML front matter shows as one dimmed text block, not hr + paragraph", () => {
  const h = renderMd("---\ntitle: X <b>\ntype: ref\n---\n\n# Real\n");
  assert.match(h, /^<pre id="B1" data-l="1" class="blk rawhtml"><code>title: X &lt;b&gt;\ntype: ref<\/code><\/pre>\n<h1 id="real"/);
  assert.doesNotMatch(h, /<hr/);
  assert.match(renderMd("---\n\ntext\n"), /<hr/, "a lone leading rule is still a rule");
});

test("a NUL in the source cannot forge a placeholder to pull in other markup", () => {
  const h = renderMd("`<i>x</i>` \0" + "0\0");
  assert.ok(h.includes("<code>&lt;i&gt;x"));
  assert.equal(h.match(/<code>/g)?.length, 1, "the forged \\0" + "0\\0 must not replay the parked code span");
});

// ---- security table ---------------------------------------------------------------------------------

const HOSTILE = [
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](java\tscript:alert(1))",
  "[x](&#106;avascript:alert(1))",
  "[x](javascript&colon;alert(1))",
  "[x](data:text/html,<script>alert(1)</script>)",
  "[x](vbscript:msgbox(1))",
  "[x](//evil.com/p)",
  "[x](\\\\evil.com\\p)",
  "[x](%6aavascript:alert(1))x[y](file:///etc/passwd)",
  "[x]( javascript:alert(1))",
];

test("security: hostile link targets never become an href", () => {
  for (const md of HOSTILE) {
    const h = renderMd(md);
    assert.doesNotMatch(h, /<a /, `no anchor for: ${JSON.stringify(md)}`);
  }
  // %6a stays inert: percent-encoded text in a relative path is not a scheme to a browser
  assert.match(renderMd("[x](%6aavascript:alert(1))"), /^<p[^>]*>\[x\]\(%6aavascript:alert\(1\)\)<\/p>$/);
});

test("security: <script>, <img onerror>, and HTML in link text or a URL are escaped, nothing runs", () => {
  const h = renderMd('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[<b onmouseover=alert(1)>t</b>](https://a.dev)\n\n[x](https://a.dev/"onmouseover="alert(1))');
  assert.doesNotMatch(h, /<script|<img|<b /i);
  assert.doesNotMatch(h, /<[^>]*\son(error|mouseover)=/i, "no live handler attribute");
  assert.ok(h.includes("&lt;script&gt;"));
  assert.match(h, /<a href="https:\/\/a\.dev" [^>]*>&lt;b onmouseover=alert\(1\)&gt;t&lt;\/b&gt;<\/a>/);
  assert.match(h, /href="https:\/\/a\.dev\/&quot;onmouseover=&quot;alert\(1"/, "quote in a URL stays inside the attribute");
});

test("security: the allowlist function", () => {
  for (const ok of ["https://a.dev/x", "http://a.dev", "#frag", "docs/a.md", "./a.md", "../a.md", "a.md#x", "/abs/p", "a?b=c:d"]) assert.equal(safeHref(ok), true, ok);
  for (const bad of ["javascript:x", "JAVASCRIPT:x", "//e.com", "data:x", "mailto:a@b", "file:///x", "https://", " javascript:x", "a\tb", "&#106;x", "\\\\e.com"]) assert.equal(safeHref(bad), false, bad);
});

test("perf: a heading line with a long whitespace run renders in linear time (was cubic: 2000 spaces ~10 s)", () => {
  const t = Date.now();
  renderMd("# a" + " ".repeat(2000) + "x");
  renderMd("## a" + " ".repeat(2000) + "x ##");
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
});

test("headings: closing # run and surrounding space are stripped", () => {
  assert.match(renderMd("## title ##"), />title<\/h2>/);
  assert.match(renderMd("##   spaced   ###   "), />spaced<\/h2>/);
  assert.match(renderMd("# C#"), />C<\/h1>/, "trailing # is a closing run, as before");
});

test("perf: unclosed [ / ]( / * / _ runs render in bounded time (were quadratic: 20000 `[` ~1.6 s, 50000 ~8.8 s)", () => {
  const cases = ["[".repeat(50000), "[x](".repeat(12500), " *a".repeat(20000), " *a*a".repeat(10000), " _a_a".repeat(10000)];
  const t = Date.now();
  for (const c of cases) renderMd(c);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test("inline spans: normal links, bold, italic still render; slug of a link heading unchanged", () => {
  const h = renderMd("# See [the docs](docs/a.md) now\n\n**bold text** and *em text* and _und_ [l](https://x.dev)");
  assert.match(h, /<h1 id="see-the-docs-now"/);
  assert.match(h, /<strong>bold text<\/strong> and <em>em text<\/em> and <em>und<\/em>/);
});

test("heading ids: never empty, never repeated (`# !!!`, and `a`,`a`,`a-1`)", () => {
  const h = renderMd("# !!!\n\n# ???\n\n# a\n\n# a\n\n# a-1\n");
  const ids = [...h.matchAll(/<h1 id="([^"]*)"/g)].map((x) => x[1]);
  assert.ok(ids.every(Boolean), "no empty id");
  assert.equal(new Set(ids).size, ids.length, ids.join(","));
  assert.deepEqual(ids.slice(2, 4), ["a", "a-1"], "ordinary duplicate numbering is unchanged");
});
