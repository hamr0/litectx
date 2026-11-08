// Small markdown → HTML renderer for the ui file view. Vanilla, no dependency. It covers what repo docs use:
// headings, paragraphs, bold/italic/inline code, links, lists (one nesting level), fenced code, blockquotes,
// GFM tables, hr. Everything else is shown as text. All text is escaped BEFORE any markup is added, so raw
// HTML in a file can only ever appear as visible text, never run.

/** @param {string} s */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Link allowlist: http(s)://, #anchor, or a relative path. Anything with another scheme (javascript:, data:,
 * vbscript:, ...), a protocol-relative `//host`, control characters, whitespace or a backslash, or an HTML entity is refused.
 * @param {string} u the URL with `&amp;`/`&quot;` already decoded
 */
export function safeHref(u) {
  if (/[\x00-\x20\x7f\\]/.test(u) || /&#?\w+;/.test(u)) return false; // a backslash: browsers read `/\` as `//`, docs never use it in a path
  if (/^https?:\/\/[^/]/i.test(u) || u.startsWith("#")) return true;
  if (u.startsWith("//")) return false;
  return !/^[^/?#]*:/.test(u); // a colon before the first / ? # is a scheme
}

/** Heading text without its closing `##` run and surrounding space (string ops, a lazy regex backtracks cubically). @param {string} t */
function headingText(t) {
  t = t.trimEnd();
  let k = t.length;
  while (k > 0 && t[k - 1] === "#") k--;
  return t.slice(0, k).trimEnd();
}

const WS = /\s/;
const WORD = /\w/;
const TERM = /[\n\r\u2028\u2029]/g; // what `.` cannot cross

/** `<...>` runs removed with indexOf (a regex rescans to the end from every unclosed `<`, quadratic). @param {string} s */
function stripTags(s) {
  let out = "";
  let pos = 0;
  let i;
  while ((i = s.indexOf("<", pos)) >= 0) {
    const e = s.indexOf(">", i + 1);
    if (e < 0) break; // no `>` anywhere after, so no later `<` can close either
    out += s.slice(pos, i);
    pos = e + 1;
  }
  return out + s.slice(pos);
}

const URL_END_STRICT = /[)\s]/g; // what stops a strict url run
const URL_END_LOOSE = /\)/g;

/**
 * Replace every `!?[text](url)` with `fn(match, text, url)`, in one left-to-right pass. Same matches as the regex
 * `!?\[([^\]]*)\]\(url\)`, but never rescans. Strategy: `p` walks the `[`; `q` is the first `]` after it, so all
 * `[` before one `]` share it. `stop` is the first url-end char at or after the url start; `q` only moves right, so
 * every url start lies at or after the last one and `stop` stays valid until a start passes it.
 * @param {string} t @param {boolean} strict url = 1+ chars without whitespace or `)` (else any run up to `)`)
 * @param {(m: string, text: string, url: string) => string} fn
 */
export function replaceLinks(t, strict, fn) {
  const urlEnd = strict ? URL_END_STRICT : URL_END_LOOSE;
  let out = "";
  let pos = 0; // end of what is already copied to out
  let p = 0;
  let q = -1;
  let stop = -1;
  while ((p = t.indexOf("[", p)) >= 0) {
    if (q <= p) q = t.indexOf("]", p + 1);
    if (q < 0) break; // no `]` left, so no later `[` can close either
    if (t[q + 1] !== "(") { p = q; continue; }
    const x = q + 2;
    if (stop < x) {
      urlEnd.lastIndex = x;
      stop = urlEnd.exec(t)?.index ?? t.length;
    }
    if (t[stop] !== ")" || (strict && stop === x)) { p = q; continue; }
    const start = t[p - 1] === "!" ? p - 1 : p;
    out += t.slice(pos, start) + fn(t.slice(start, stop + 1), t.slice(p + 1, q), t.slice(x, stop));
    pos = p = stop + 1;
  }
  return out + t.slice(pos);
}

/** Index finder for the first line terminator (what `.` cannot cross) at or after p, cached so the total scan is linear. @param {string} t */
function lineEnd(t) {
  let nt = -1;
  return (/** @type {number} */ p) => {
    if (nt < p) {
      TERM.lastIndex = p;
      const m = TERM.exec(t);
      nt = m ? m.index : t.length;
    }
    return nt;
  };
}

/** `**x**` to <strong>: the first `**` after one char or more, on one line, found without rescanning. @param {string} t */
function strongs(t) {
  const end = lineEnd(t);
  let out = "";
  let pos = 0;
  let from = 0;
  let nk = -2; // first `**` at or after the last asked position, cached
  while (true) {
    const f = t.indexOf("**", from);
    if (f < 0) break;
    const c = f + 2;
    if (nk !== -1 && nk < c + 1) nk = t.indexOf("**", c + 1);
    const eol = end(c);
    if (nk < 0 || nk >= eol) { from = eol > f ? eol : f + 1; continue; } // no closer on this line: no later opener on it has one
    out += `${t.slice(pos, f)}<strong>${t.slice(c, nk)}</strong>`;
    pos = from = nk + 2;
  }
  return out + t.slice(pos);
}

/**
 * `*x*` / `_x_` to <em>: opener at the start or after a non-`bad` char and before a non-space, closer the first
 * same char not followed by a word char, on one line; found without rescanning.
 * @param {string} t @param {string} ch @param {RegExp} bad a char that may not precede the opener
 */
function emphasis(t, ch, bad) {
  const end = lineEnd(t);
  let out = "";
  let pos = 0;
  let j = 0;
  while ((j = t.indexOf(ch, j)) >= 0) {
    const c = j + 1;
    if (c >= t.length) break;
    if ((j > 0 && (j - 1 < pos || bad.test(t[j - 1]))) || WS.test(t[c])) { j = c; continue; }
    const eol = end(c);
    let k = c + 1;
    while (k < eol && !(t[k] === ch && !WORD.test(t[k + 1] ?? ""))) k++;
    if (k >= eol) { j = eol; continue; } // no closer on this line: no later opener on it has one
    out += `${t.slice(pos, j)}<em>${t.slice(c, k)}</em>`;
    pos = j = k + 1;
  }
  return out + t.slice(pos);
}

/** GitHub-style heading slug: lowercase, spaces to -, punctuation dropped. @param {string} raw */
function slugOf(raw) {
  const t = replaceLinks(stripTags(raw), false, (_, text) => text).replace(/[`*]/g, "");
  return t.toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
}

/** @param {string} raw one line or paragraph of markdown text, returns safe HTML */
function inline(raw) {
  /** @type {string[]} */
  const keep = []; // finished HTML parked behind a placeholder so later passes can't touch it
  const park = (/** @type {string} */ h) => `\0${keep.push(h) - 1}\0`;
  let t = esc(raw.replace(/\0/g, "")).replace(/`([^`]+)`/g, (_, c) => park(`<code>${c}</code>`));
  t = replaceLinks(t, true, (m, txt, url) => {
    const href = url.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    if (!safeHref(href)) return m;
    const ext = /^https?:/i.test(href);
    return `${park(`<a href="${url}" rel="noopener noreferrer"${ext ? ' target="_blank"' : ""}>`)}${txt || url}${park("</a>")}`;
  });
  t = emphasis(strongs(t), "*", /[\w*]/);
  t = emphasis(t, "_", /\w/);
  return t.replace(/\0(\d+)\0/g, (_, i) => keep[+i] ?? "");
}

/** Table cells of one row: split on `|` except inside a (closed) backtick span; `\|` is a literal pipe. @param {string} r */
function splitRow(r) {
  r = r.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  const cells = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === "\\" && r[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`" && (code || r.indexOf("`", i + 1) > 0)) code = !code;
    if (c === "|" && !code) { cells.push(cur); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

const TABLE_RULE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BLOCK_START = /^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|(-{3,}|\*{3,}|_{3,})\s*$|\s*\|)/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)/;

/**
 * Render markdown source to HTML blocks. Each block carries `data-l` (its 1-based start line) and class `blk`;
 * blocks whose line span overlaps [s, e] also get class `on`. Non-heading blocks have id `B<line>`, headings
 * the slug id. A block that is only raw HTML gets class `rawhtml`.
 * @param {string} src @param {number} [s] first line to highlight, 0 = none @param {number} [e] last line
 */
export function renderMd(src, s = 0, e = 0) {
  const L = src.split("\n");
  /** @type {string[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const slugs = new Map();
  /** @type {Set<string>} every heading id emitted so far */
  const ids = new Set();
  const blk = (/** @type {string} */ tag, /** @type {number} */ from, /** @type {number} */ to, /** @type {string} */ inner, extra = "", id = `B${from}`) =>
    out.push(`<${tag} id="${id}" data-l="${from}" class="blk${extra}${s && from <= e && to >= s ? " on" : ""}">${inner}</${tag}>`);
  let i = 0;
  const fm = L[0] === "---" ? L.indexOf("---", 1) : -1; // YAML front matter: shown dimmed as text, not as hr + paragraph
  if (fm > 0 && fm < 40) {
    blk("pre", 1, fm + 1, `<code>${esc(L.slice(1, fm).join("\n"))}</code>`, " rawhtml");
    i = fm + 1;
  }
  while (i < L.length) {
    const l = L[i].replace(/\r$/, "");
    const n = i + 1;
    if (!l.trim()) { i++; continue; }
    let m;
    if (/^```/.test(l)) {
      let j = i + 1;
      const buf = [];
      while (j < L.length && !/^```/.test(L[j])) buf.push(L[j++]);
      blk("pre", n, Math.min(j + 1, L.length), `<code>${esc(buf.join("\n"))}</code>`);
      i = j + 1;
    } else if ((m = /^(#{1,6})\s+([\s\S]*)$/.exec(l))) {
      m[2] = headingText(m[2]);
      const base = slugOf(m[2]) || "section"; // a heading of only punctuation would otherwise get an empty id
      let k = slugs.get(base) ?? 0;
      let id = k ? `${base}-${k}` : base;
      while (ids.has(id)) id = `${base}-${++k}`; // `a`, `a`, `a-1` must not repeat `a-1`
      slugs.set(base, k + 1);
      ids.add(id);
      blk("h" + m[1].length, n, n, inline(m[2]), "", id);
      i++;
    } else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
      blk("div", n, n, "<hr>", " rule"); // a div wrapper: a pseudo-element (the gutter number) does not render on an hr itself
      i++;
    } else if (l.startsWith(">")) {
      let j = i;
      const buf = [];
      while (j < L.length && L[j].startsWith(">")) buf.push(L[j++].replace(/^>\s?/, ""));
      blk("blockquote", n, j, inline(buf.join(" ")));
      i = j;
    } else if (l.trimStart().startsWith("|") && TABLE_RULE.test((L[i + 1] ?? "").trim())) { // indented tables (under a list item) too
      // the first cell carries the row's line (data-l) so the CSS gutter can number the row
      const cells = (/** @type {string} */ r, /** @type {string} */ tag, /** @type {number} */ line) =>
        splitRow(r).map((c, k) => `<${tag}${k ? "" : ` data-l="${line}"`}>${inline(c.trim())}</${tag}>`).join("");
      let j = i + 2;
      const rows = [];
      for (; j < L.length && L[j].trimStart().startsWith("|"); j++) rows.push(`<tr data-l="${j + 1}">${cells(L[j], "td", j + 1)}</tr>`);
      blk("table", n, j, `<thead><tr>${cells(l, "th", n)}</tr></thead><tbody>${rows.join("")}</tbody>`);
      i = j;
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(l))) {
      const tag = /\d/.test(m[2]) ? "ol" : "ul";
      const base = m[1].length;
      let j = i;
      /** @type {{ line: number, nested: boolean, ord: boolean, text: string }[]} */
      const items = [];
      for (; j < L.length && L[j].trim(); j++) {
        const im = ITEM.exec(L[j]);
        if (im) items.push({ line: j + 1, nested: im[1].length >= base + 2, ord: /\d/.test(im[2]), text: im[3] });
        else if (/^\s+\S/.test(L[j]) && !BLOCK_START.test(L[j])) items[items.length - 1].text += ` ${L[j].trim()}`; // wrapped item text, inlined whole so **bold** can span lines
        else break;
      }
      const html = []; // pieces, each ending in </li>; the last one is reopened when a nested list starts
      let open = "";
      for (const it of items) {
        if (it.nested && !open) {
          open = it.ord ? "ol" : "ul";
          const last = html.length - 1;
          if (last >= 0 && html[last].endsWith("</li>")) html[last] = html[last].slice(0, -5);
          html.push(`<${open}>`);
        }
        if (!it.nested && open) { html.push(`</${open}></li>`); open = ""; }
        html.push(`<li data-l="${it.line}">${inline(it.text)}</li>`);
      }
      if (open) html.push(`</${open}></li>`);
      blk(tag, n, j, html.join(""));
      i = j;
    } else {
      let j = i;
      const buf = [];
      while (j < L.length && L[j].trim() && (j === i || !BLOCK_START.test(L[j]))) buf.push(L[j++].trim());
      const text = buf.join(" ");
      blk("p", n, j, inline(text), /^\s*(<[^>]*>\s*)+$/.test(text) ? " rawhtml" : "");
      i = j;
    }
  }
  return out.join("\n");
}
