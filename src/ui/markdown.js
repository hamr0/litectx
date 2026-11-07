// Small markdown → HTML renderer for the ui file view. Vanilla, no dependency. It covers what repo docs use:
// headings, paragraphs, bold/italic/inline code, links, lists (one nesting level), fenced code, blockquotes,
// GFM tables, hr. Everything else is shown as text. All text is escaped BEFORE any markup is added, so raw
// HTML in a file can only ever appear as visible text, never run.

/** @param {string} s */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Link allowlist: http(s)://, #anchor, or a relative path. Anything with another scheme (javascript:, data:,
 * vbscript:, ...), a protocol-relative `//host`, control characters or whitespace, or an HTML entity is refused.
 * @param {string} u the URL with `&amp;`/`&quot;` already decoded
 */
export function safeHref(u) {
  if (/[\x00-\x20\x7f]/.test(u) || /&#?\w+;/.test(u)) return false;
  if (/^https?:\/\/[^/]/i.test(u) || u.startsWith("#")) return true;
  if (u.startsWith("//") || u.startsWith("\\")) return false;
  return !/^[^/?#]*:/.test(u); // a colon before the first / ? # is a scheme
}

/** GitHub-style heading slug: lowercase, spaces to -, punctuation dropped. @param {string} raw */
function slugOf(raw) {
  const t = raw.replace(/<[^>]*>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "");
  return t.toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
}

/** @param {string} raw one line or paragraph of markdown text, returns safe HTML */
function inline(raw) {
  /** @type {string[]} */
  const keep = []; // finished HTML parked behind a placeholder so later passes can't touch it
  const park = (/** @type {string} */ h) => `\0${keep.push(h) - 1}\0`;
  let t = esc(raw.replace(/\0/g, "")).replace(/`([^`]+)`/g, (_, c) => park(`<code>${c}</code>`));
  t = t.replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (m, txt, url) => {
    const href = url.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    if (!safeHref(href)) return m;
    const ext = /^https?:/i.test(href);
    return `${park(`<a href="${url}" rel="noopener noreferrer"${ext ? ' target="_blank"' : ""}>`)}${txt || url}${park("</a>")}`;
  });
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/(^|\W)_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>");
  return t.replace(/\0(\d+)\0/g, (_, i) => keep[+i] ?? "");
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
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) {
      const base = slugOf(m[2]);
      const k = slugs.get(base) ?? 0;
      slugs.set(base, k + 1);
      blk("h" + m[1].length, n, n, inline(m[2]), "", k ? `${base}-${k}` : base);
      i++;
    } else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
      blk("hr", n, n, "");
      i++;
    } else if (l.startsWith(">")) {
      let j = i;
      const buf = [];
      while (j < L.length && L[j].startsWith(">")) buf.push(L[j++].replace(/^>\s?/, ""));
      blk("blockquote", n, j, inline(buf.join(" ")));
      i = j;
    } else if (l.trimStart().startsWith("|") && TABLE_RULE.test((L[i + 1] ?? "").trim())) { // indented tables (under a list item) too
      const cells = (/** @type {string} */ r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let j = i + 2;
      const rows = [];
      while (j < L.length && L[j].trimStart().startsWith("|")) rows.push(`<tr data-l="${j + 1}">${cells(L[j++]).map((c) => `<td>${c}</td>`).join("")}</tr>`);
      blk("table", n, j, `<thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody>`);
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
      let html = "";
      let open = "";
      for (const it of items) {
        if (it.nested && !open) {
          open = it.ord ? "ol" : "ul";
          html = html.replace(/<\/li>$/, "") + `<${open}>`;
        }
        if (!it.nested && open) { html += `</${open}></li>`; open = ""; }
        html += `<li data-l="${it.line}">${inline(it.text)}</li>`;
      }
      if (open) html += `</${open}></li>`;
      blk(tag, n, j, html);
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
