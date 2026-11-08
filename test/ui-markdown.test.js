// Renderer for the ui file view (src/ui/markdown.js). Unit tests per feature, plus the security table:
// every hostile input must come out as inert text, never as a live link, tag or handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMd, replaceLinks, safeHref } from "../src/ui/markdown.js";

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
  for (const ok of ["https://a.dev/x", "http://a.dev", "#frag", "docs/a.md", "./a.md", "../a.md", "a.md#x", "/abs/p", "a?b=c:d", "../y.md#h", "#a", "https://x.y/p"]) assert.equal(safeHref(ok), true, ok);
  for (const bad of ["javascript:x", "JAVASCRIPT:x", "//e.com", "data:x", "mailto:a@b", "file:///x", "https://", " javascript:x", "a\tb", "&#106;x", "\\\\e.com", "/\\evil.com", "/\\\\evil.com", "a\\b"]) assert.equal(safeHref(bad), false, bad);
});

test("replaceLinks: the !?[text](url) scanner, strict (inline links) and non-strict (heading slugs)", () => {
  const f = (/** @type {string} */ t, strict = true) => replaceLinks(t, strict, (_, text, url) => `<${text}|${url}>`);
  // expected values follow the regex `!?\[([^\]]*)\]\(url\)`: text may hold `[` and newlines but never `]`
  const same = ["", "plain", "[a", "[a(b)", "[a] (b)", "[a]](b)", "[a](b", "]( [a]", "[a]("];
  for (const t of same) assert.equal(f(t), t, JSON.stringify(t));
  const cases = [
    ["[a](b)", "<a|b>"],
    ["![a](b)", "<a|b>", "a leading ! belongs to the match"],
    ["x ![a](b) y", "x <a|b> y"],
    ["a![x](y)", "a<x|y>"],
    ["![a](b)![c](d)", "<a|b><c|d>", "a ! right after a match still binds"],
    ["[a](b) [c](d)", "<a|b> <c|d>"],
    ["[[a](b)", "<[a|b>", "nested [: all share the first ]"],
    ["[a][b](c)", "[a]<b|c>", "] not followed by ( moves on to the next ["],
    ["[a](b)(c)", "<a|b>(c)", "match ends at the first )"],
    ["[a](b(c))", "<a|b(c>)", "a paren url ends at its first )"],
    ["[](u)", "<|u>", "empty text is fine"],
    ["[a\nb](c)", "<a\nb|c>", "text crosses a newline"],
    ["[a](x [b](c)", "[a](x <b|c>", "strict: a failed url does not hide a later link"],
  ];
  for (const [t, want, why] of cases) assert.equal(f(t), want, why ?? JSON.stringify(t));
  // strict needs 1+ url chars and no whitespace; non-strict takes any run up to the first )
  for (const t of ["[a]()", "[a](b c)", "[a](b\nc)"]) assert.equal(f(t), t, "strict refuses " + JSON.stringify(t));
  assert.equal(f("[a]()", false), "<a|>");
  assert.equal(f("[a](b c)", false), "<a|b c>");
  assert.equal(f("[a](b\nc)", false), "<a|b\nc>");
  assert.equal(f("[a](x [b](c)", false), "<a|x [b](c>", "non-strict: the url runs to the first )");
  assert.equal(f("[a](b", false), "[a](b");
  // fn gets the whole match first
  const seen = [];
  replaceLinks("k ![t](u) z", true, (m, text, url) => (seen.push([m, text, url]), ""));
  assert.deepEqual(seen, [["![t](u)", "t", "u"]]);
});

/** best of 3 wall-clock ms for one render (min cuts scheduler/load noise) @param {string} src */
function best(src) {
  let m = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    renderMd(src);
    m = Math.min(m, performance.now() - t);
  }
  return m;
}

/**
 * Pairwise perf check: render `hostile` repeated to ~n chars against `ok` (well-formed, same size and kind) repeated alike.
 * Same rendering work on both sides, so a loaded box slows them equally; a ratio over 4 means the hostile input costs more per
 * char than the well-formed one (the old quadratic/cubic code was 8x to 50x+ at these sizes).
 * @param {string} bad @param {string} ok @param {number} n
 */
function assertPairwise(bad, ok, n) {
  const hostile = best(bad.repeat(Math.ceil(n / bad.length)));
  const closed = best(ok.repeat(Math.ceil(n / ok.length)));
  assert.ok(hostile < 4 * Math.max(closed, 2), `${JSON.stringify(bad)}: ${hostile.toFixed(1)} ms vs well-formed ${closed.toFixed(1)} ms`);
}

test("perf: a heading line with a long whitespace run costs about the same as a plain one of equal size (was cubic: 1500 spaces ~1.5 s)", () => {
  // relative, not absolute: a loaded box slows both sides alike. Old code is ~1000x the plain line, new ~1x.
  const plain = best("# a" + "b".repeat(1500) + "x");
  const spaced = Math.max(best("# a" + " ".repeat(1500) + "x"), best("## a" + " ".repeat(1500) + "x ##"));
  assert.ok(spaced < 25 * Math.max(plain, 4), `spaced ${spaced.toFixed(1)} ms vs plain ${plain.toFixed(1)} ms`);
});

test("headings: closing # run and surrounding space are stripped", () => {
  assert.match(renderMd("## title ##"), />title<\/h2>/);
  assert.match(renderMd("##   spaced   ###   "), />spaced<\/h2>/);
  assert.match(renderMd("# C#"), />C<\/h1>/, "trailing # is a closing run, as before");
});

test("perf: unclosed [ / ]( / * / _ runs cost about the same as the well-formed span of equal size (were quadratic)", () => {
  for (const [bad, ok] of [["[", "[x](y) "], ["[x](", "[x](y) "], [" *a", " *a* "], [" *a*a", " *a* "], [" _a_a", " _a_ "]]) assertPairwise(bad, ok, 40000);
});

test("perf: nested lists and a heading of unclosed < cost about the same as their well-formed equivalents (were ~cubic / quadratic)", () => {
  assertPairwise("- a\n  - b\n", "- a\n- b\n", 80000);
  assertPairwise("1. a\n   - b\n", "1. a\n2. b\n", 80000);
  assertPairwise("# " + "<a ".repeat(26000), "# " + "<a> ".repeat(20000), 1);
  assertPairwise("# [x](" + "<a ".repeat(26000), "# [x](y) " + "<a> ".repeat(20000), 1);
});

test("perf: an unclosed span in a large input costs about the same as the well-formed span of equal size (bounded spans were 7-50x)", () => {
  // Each hostile input is timed against a WELL-FORMED input of the same size and the same span kind, not a wall clock or plain text:
  // that does the same rendering work, so a loaded box slows both sides alike. Scanner ~1x or less; the bounded-regex code was 7x (links) to 50x (*a).
  const N = 200000;
  const pairs = [["[", "[a](b) "], ["![", "![a](b) "], ["[a](", "[a](b) "], [" *a", " *a* "], [" _a_a", " _a_ "], ["**a", "**a** "]];
  for (const [bad, ok] of pairs) {
    const hostile = best(bad.repeat(N / bad.length));
    const closed = best(ok.repeat(N / ok.length));
    assert.ok(hostile < 4 * Math.max(closed, 4), `${JSON.stringify(bad)}: ${hostile.toFixed(1)} ms vs well-formed ${closed.toFixed(1)} ms`);
  }
});

test("lists and headings: output of the linear rewrite (nested open/close, tag-stripped slug)", () => {
  assert.equal(renderMd("- a\n  - b\n- c\n"), '<ul id="B1" data-l="1" class="blk"><li data-l="1">a<ul><li data-l="2">b</li></ul></li><li data-l="3">c</li></ul>');
  assert.match(renderMd("# a <b>x</b> <c"), /<h1 id="a-x-c"/);
  assert.match(renderMd("# [t](u) <i>z"), /<h1 id="t-z"/);
});

test("inline spans: a span longer than 1000 chars still styles", () => {
  const long = "x".repeat(3000);
  assert.match(renderMd(`**${long}** *${long}* _${long}_ [${long}](a.md)`), new RegExp(`<strong>x{3000}</strong> <em>x{3000}</em> <em>x{3000}</em> <a href="a.md"[^>]*>x{3000}</a>`));
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

test("tables: a | inside a code span or escaped as \\| stays in its cell", () => {
  const h = renderMd("| expr | note |\n|---|---|\n| `a|b` | x \\| y |\n| plain | `unclosed | z |\n");
  assert.match(h, /<td data-l="3"><code>a\|b<\/code><\/td><td>x \| y<\/td>/);
  assert.match(h, /<td data-l="4">plain<\/td><td>`unclosed<\/td><td>z<\/td>/, "an unclosed backtick does not swallow the row");
});
