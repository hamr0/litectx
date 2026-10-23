// litectx ui — variant F (docs/wiki/local-ui.md, DESIGN_PLAN.md). Plain JS, no dependencies.
// Every string that came from the server is passed through esc() before it touches innerHTML.
(function () {
  "use strict";
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app");
  app.innerHTML =
    '<div id="title" class="dim"></div><div id="top"></div><div id="panel"></div>' +
    '<label class="searchbox"><span class="kw" aria-hidden="true">$</span><input id="q" class="q" aria-label="search" autocomplete="off" autofocus><button type="button" id="qx" class="qx" aria-label="clear search" title="clear search" hidden>×</button></label>' +
    '<div id="filters" class="row filters"></div><div id="viewrow" class="row"></div><div id="results"></div>';
  var tip = document.createElement("div");
  tip.id = "tip"; tip.setAttribute("role", "tooltip"); document.body.appendChild(tip);

  var ST = window.litectxState;
  var s = {
    q: "", sub: "", kinds: { doc: false, code: false }, ext: null, repos: [], folder: null, demote: true,
    view: "table", open: null, openOthers: false, hits: [], facets: { exts: [], folders: [] }, ms: 0,
    st: null, settings: false, msg: "", searched: false, busy: null, result: ""
  };

  function api(method, url, body) {
    var o = { method: method, headers: {} };
    if (body !== undefined) { o.body = JSON.stringify(body); o.headers["content-type"] = "application/json"; }
    return fetch(url, o).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; });
    });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function chip(label, on, fn, title) {
    var b = el("button", "chip", label); b.type = "button"; b.setAttribute("aria-pressed", on ? "true" : "false");
    if (title) b.title = title; b.onclick = fn; return b;
  }

  // ---- data ---------------------------------------------------------------------------------------
  function loadState() {
    return api("GET", "/api/sources").then(function (st) {
      s.st = st; $("title").innerHTML = '<span class="fgc">litectx tinymem</span> · v' + esc(st.version) + " · lightning local retrieval"; document.title = "litectx tinymem v" + st.version;
      if (!st.sources.length) s.settings = true;
      var ix = !!(st.current && st.current.indexing);
      if (ix && !s.busy) s.busy = { what: "reindex", label: "re-indexing…", t0: Date.now() }; // a pass the server started itself
      if (!ix && s.busy && !s.busy.pending) endBusy(st);
      renderTop(); renderPanel(); renderFilters();
      return st;
    });
  }
  function runSearch() {
    s.searched = true;
    if (!s.q.trim() || !s.st || !s.st.current) { s.hits = []; renderResults(); renderTop(); return Promise.resolve(); }
    var kinds = Object.keys(s.kinds).filter(function (k) { return s.kinds[k]; });
    if (!kinds.length) kinds = ["doc", "code"]; // none picked = no filter: search both
    var p = new URLSearchParams({ q: s.q, kinds: kinds.join(","), demote: s.demote ? "1" : "0" });
    if (s.repos.length) p.set("repos", s.repos.join(","));
    if (s.ext) p.set("ext", s.ext);
    if (s.folder) p.set("folder", s.folder);
    return api("GET", "/api/search?" + p).then(function (r) {
      s.hits = r.hits; s.facets = r.facets; s.ms = r.ms; s.kwOnly = !!r.keywordsOnly; s.msg = "";
      if (s.open && !s.hits.some(function (h) { return h.path === s.open; })) s.open = null;
      renderTop(); renderFilters(); renderResults();
    }).catch(function (e) { s.msg = e.message; renderResults(); });
  }
  // ---- busy state: set by the page at click time, cleared when the server reports the pass finished -----
  var tickTimer = null;
  function startBusy(what, label) {
    s.busy = { what: what, label: label, t0: Date.now(), pending: true };
    clearInterval(tickTimer); tickTimer = setInterval(tick, 1000);
    renderTop();
  }
  function tick() { var e = $("elapsed"); if (e && s.busy) e.textContent = " " + Math.round((Date.now() - s.busy.t0) / 1000) + " s"; }
  function endBusy(st) {
    var b = s.busy, c = st && st.current; s.busy = null; clearInterval(tickTimer);
    if (b.what === "reindex" && c && c.last) s.result = "re-indexed " + ST.passText(c.last);
    else if (b.what === "meaning" && c) s.result = c.embeddings ? (c.meaningOff ? "" : "meaning: built") : "meaning: off";
    else s.result = "";
  }
  // run a server action behind an instant busy state; the page never waits on the server to show it
  // `quick`: the call itself is the whole job (remove) — drop the label once it returns, so a pass the server
  // started for the next source shows as its own "re-indexing…" instead of keeping "removing …" up for minutes
  function act(what, label, call, quick) {
    startBusy(what, label);
    return call().then(function () { if (quick) { s.busy = null; clearInterval(tickTimer); } else s.busy && (s.busy.pending = false); return refresh(); })
      .catch(function (e) { s.busy = null; clearInterval(tickTimer); fail(e); renderTop(); });
  }
  var pollTimer = null;
  function poll() {
    clearTimeout(pollTimer);
    if (!s.st || !s.st.current || !s.st.current.indexing) return;
    pollTimer = setTimeout(function () {
      loadState().then(function (st) { if (st.current && !st.current.indexing) runSearch(); else poll(); });
    }, 1500);
  }
  function refresh() { return loadState().then(function () { poll(); return runSearch(); }); }

  // ---- top bar + settings -------------------------------------------------------------------------
  function renderTop() {
    var t = $("top"); t.innerHTML = "";
    var st = s.st, c = st && st.current;
    var bar = el("div", "topbar");
    var left = el("div", "row");
    if (st && st.sources.length) {
      var sel = el("select", "chip"); sel.setAttribute("aria-label", "source");
      st.sources.forEach(function (x) { var o = el("option", "", x.name); o.value = x.name; if (x.name === st.active) o.selected = true; sel.appendChild(o); });
      sel.onchange = function () { s.repos = []; s.open = null; act("reindex", "opening " + sel.value + "…", function () { return api("POST", "/api/sources", { active: sel.value }); }); };
      sel.disabled = !!s.busy;
      left.appendChild(sel);
    }
    var info = el("span", "dim");
    if (s.busy) {
      info.appendChild(el("span", "spin")); info.appendChild(document.createTextNode(" " + s.busy.label));
      var ev = el("span", "", " " + Math.round((Date.now() - s.busy.t0) / 1000) + " s"); ev.id = "elapsed"; info.appendChild(ev);
    }
    else if (c) info.textContent = c.files.toLocaleString() + " files" + (s.searched && s.q ? " · " + s.hits.length + " results · " + s.ms + " ms" : "") + " · " + c.modeText + (s.result ? " · " + s.result : "");
    else if (st && st.error) { info.className = "err"; info.textContent = st.error; }
    else info.textContent = "no source yet";
    left.appendChild(info);
    if (c && c.embeddings && c.meaningOff && !s.busy) left.appendChild(el("span", "err", "meaning unavailable: install the optional peer `npm i @huggingface/transformers` (searching by keywords only)"));
    if (s.kwOnly && s.busy && s.searched && s.q) left.appendChild(el("span", "dim", "searching by keywords only while building (meaning is back when it finishes)"));
    if (c && c.error) left.appendChild(el("span", "err", "index error: " + c.error));
    var right = el("div", "row end");
    if (c) {
      var busyRe = !!s.busy && s.busy.what !== "meaning", busyMe = !!s.busy && s.busy.what === "meaning";
      var rb = chip("↻ re-index", busyRe, function () { act("reindex", "re-indexing…", function () { return api("POST", "/api/reindex", {}); }); }, "refresh changed files now");
      if (busyRe) rb.insertBefore(el("span", "spin"), rb.firstChild);
      rb.disabled = !!s.busy; right.appendChild(rb);
      var mb = chip(busyMe ? "building meaning…" : c.embeddings ? "meaning: on" : "meaning: off", c.embeddings || busyMe, function () {
        var on = !c.embeddings;
        act("meaning", on ? "building meaning… (first build takes minutes; search keeps working on keywords)" : "turning meaning off…", function () { return api("POST", "/api/sources", { name: c.name, embeddings: on }); });
      }, "embeddings re-order results by meaning. First turn-on builds them once (~15 min for ~7k files).");
      if (busyMe) mb.insertBefore(el("span", "spin"), mb.firstChild);
      mb.disabled = !!s.busy; right.appendChild(mb);
    }
    right.appendChild(chip("sources", s.settings, function () { s.settings = !s.settings; renderPanel(); }, "add, remove or switch sources"));
    var th = chip("theme", false, function () {
      var cur = document.documentElement.getAttribute("data-theme"), next = cur === "light" ? "dark" : cur === "dark" ? null : "light";
      if (next) document.documentElement.setAttribute("data-theme", next); else document.documentElement.removeAttribute("data-theme");
      try { if (next) localStorage.setItem("litectx-ui-theme", next); else localStorage.removeItem("litectx-ui-theme"); } catch (e) { /* ignore */ }
      th.textContent = "theme: " + (next || "auto");
    }, "auto → light → dark");
    th.textContent = "theme: " + (document.documentElement.getAttribute("data-theme") || "auto");
    right.appendChild(th);
    bar.appendChild(left); bar.appendChild(right); t.appendChild(bar);
  }
  function fail(e) { s.msg = e.message; renderPanel(); renderResults(); }

  function renderPanel() {
    var p = $("panel"); p.innerHTML = "";
    if (!s.settings || !s.st) return;
    var box = el("div", "panel");
    var first = !s.st.sources.length;
    box.appendChild(el("div", "", first ? "Add a source: a git repo, or a folder that holds git repos." : "Sources"));
    s.st.sources.forEach(function (x) {
      var r = el("div", "src");
      r.innerHTML = '<b class="sym">' + esc(x.name) + '</b><span class="dim">' + esc(x.path) + "</span><span>" +
        (x.error ? '<span class="err">' + esc(x.error) + "</span>" : x.mode === "repo" ? "one repo" : "all repos (" + esc(x.repos) + ")") + "</span>";
      if (x.name !== s.st.active) r.appendChild(chip("set default", false, function () { s.repos = []; act("reindex", "opening " + x.name + "…", function () { return api("POST", "/api/sources", { active: x.name }); }); }));
      var lab = el("label", "dim");
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.setAttribute("aria-label", "also delete the index of " + x.name);
      if (x.mode === "repos") { lab.appendChild(cb); lab.appendChild(document.createTextNode(" also delete its index")); }
      r.appendChild(chip("remove", false, function () {
        act("reindex", "removing " + x.name + "…", function () { return api("DELETE", "/api/sources", { name: x.name, deleteIndex: cb.checked }); }, true);
      }, x.mode === "repo" ? "removes it from this list only; the repo's own index stays (agents use it)" : "removes it from this list"));
      if (x.mode === "repos") r.appendChild(lab);
      box.appendChild(r);
    });
    var f = el("form", "src");
    f.innerHTML = '<input type="text" name="name" placeholder="name" aria-label="source name" size="14"><input type="text" name="path" placeholder="/absolute/path" aria-label="source path" size="40" required>';
    var sub = el("button", "chip", "Submit"); sub.type = "submit"; f.appendChild(sub);
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var name = f.elements.name.value.trim(), body = { path: f.elements.path.value.trim() };
      if (name) body.name = name;
      act("reindex", "adding source…", function () { return api("POST", "/api/sources", body).then(function () { s.settings = false; s.msg = ""; s.repos = []; }); });
    };
    box.appendChild(f);
    if (s.msg) box.appendChild(el("div", "err", s.msg));
    p.appendChild(box);
  }

  // ---- filter line --------------------------------------------------------------------------------
  function renderFilters() {
    var k = $("filters");
    // status ticks and search replies rebuild this line; the repo box is kept (value, caret, list) so typing in it is never cut off
    var pk = pickEl && pickEl.firstChild, typing = !!pk && document.activeElement === pk, caret = typing ? [pk.selectionStart, pk.selectionEnd] : null;
    k.innerHTML = "";
    var go = function (fn) { return function () { fn(); runSearch(); }; };
    // fixed order: the always-there controls first so they never move; the per-search suggestions after
    k.appendChild(chip("docs", s.kinds.doc, go(function () { s.kinds.doc = !s.kinds.doc; })));
    k.appendChild(chip("code", s.kinds.code, go(function () { s.kinds.code = !s.kinds.code; })));
    k.appendChild(chip("old/tests last", s.demote, go(function () { s.demote = !s.demote; }), "archive, poc, tests and logs go to the bottom"));
    var group = function (fn) { var n = k.children.length; fn(); if (k.children.length > n) k.children[n].className += " gs"; }; // groups read apart by spacing, no separators
    group(function () {
    s.repos.forEach(function (r) { k.appendChild(chip(r + " ✕", true, go(function () { s.repos = s.repos.filter(function (x) { return x !== r; }); }), "remove filter")); });
    k.appendChild(repoInput());
    });
    group(function () { s.facets.exts.forEach(function (e) { k.appendChild(chip("." + e, s.ext === e, go(function () { s.ext = s.ext === e ? null : e; }))); }); });
    group(function () { s.facets.folders.slice(0, 6).forEach(function (f) { k.appendChild(chip(f + "/", s.folder === f, go(function () { s.folder = s.folder === f ? null : f; }), "folder " + f)); }); });
    if (ST.hasFilters(s)) { var ca = chip("✕ clear", false, go(function () { ST.clearFilters(s); }), "reset repos, docs/code, type, folder and old/tests last; keeps the query"); ca.className += " clear gs"; k.appendChild(ca); }
    if (typing) { pk.focus(); pk.setSelectionRange(caret[0], caret[1]); }
  }
  // escape the name and the query separately, then wrap the first case-insensitive match (real-case letters kept)
  function hilite(name, q) {
    var at = q ? name.toLowerCase().indexOf(q) : -1;
    if (at < 0) return esc(name);
    return esc(name.slice(0, at)) + '<span class="kw">' + esc(name.slice(at, at + q.length)) + "</span>" + esc(name.slice(at + q.length));
  }
  var pickEl = null; // built once, re-attached on every filter-line rebuild
  function repoInput() {
    if (!pickEl) pickEl = buildRepoInput();
    pickEl.firstChild.placeholder = s.repos.length ? "add repo…" : "type a repo name…";
    return pickEl;
  }
  function buildRepoInput() {
    var w = el("span", "pick"), i = el("input", "chip");
    i.setAttribute("aria-label", "filter by repo");
    var ul = el("div", "suggest"); ul.setAttribute("role", "listbox"); ul.hidden = true;
    var pick = function (r) { if (s.repos.indexOf(r) < 0) s.repos.push(r); i.value = ""; ul.hidden = true; renderFilters(); runSearch(); i.focus(); };
    i.oninput = function () {
      var names = (s.st && s.st.current && s.st.current.repoNames) || [];
      var q = i.value.toLowerCase();
      var m = q ? names.filter(function (r) { return r.toLowerCase().indexOf(q) >= 0 && s.repos.indexOf(r) < 0; }).slice(0, 6) : [];
      ul.innerHTML = m.map(function (r, n) { return '<div role="option" data-r="' + esc(r) + '"' + (n === 0 ? ' class="first"' : "") + ">" + hilite(r, q) + "</div>"; }).join("") ||
        (q ? '<div class="dim">no repo matches</div>' : "");
      ul.hidden = !q;
      Array.prototype.forEach.call(ul.querySelectorAll("[data-r]"), function (o) { o.onmousedown = function () { pick(o.dataset.r); }; });
    };
    i.onkeydown = function (e) {
      var f = ul.querySelector("[data-r]");
      if (e.key === "Enter" && f) pick(f.dataset.r);
      if (e.key === "Escape") { i.value = ""; ul.hidden = true; }
    };
    // a rebuild detaches the box and blurs it for a moment; only hide the list if focus really went elsewhere
    i.onblur = function () { setTimeout(function () { if (document.activeElement !== i) ul.hidden = true; }, 120); };
    w.appendChild(i); w.appendChild(ul); return w;
  }

  // ---- results ------------------------------------------------------------------------------------
  // "open in pycharm": the server launches the editor (no URL handler needed); feedback shows beside the button
  function openInEditor(h, btn, note) {
    btn.disabled = true; note.className = "dim"; note.textContent = " opening…";
    api("POST", "/api/open", { path: h.path, line: h.start })
      .then(function () { note.textContent = " opened"; })
      .catch(function (e) { note.className = "err"; note.textContent = " " + e.message; })
      .then(function () { btn.disabled = false; });
  }
  function viewUrl(h, a, b) { return "/view?p=" + encodeURIComponent(h.path) + "&s=" + a + "&e=" + b + "#L" + a; }
  function marker(h) { return h.keyword ? '<span class="kw">keyword match</span>' : '<span class="mo">meaning only</span>'; }
  function loc(h) { return esc(h.file) + '<span class="dim">:' + h.start + "</span>" + (h.more ? ' <span class="dim">+' + h.more + "</span>" : ""); }

  function renderResults() {
    hideTip(); sync(false);
    var vr = $("viewrow"); vr.innerHTML = "";
    var on = s.view === "roomy";
    var b = el("button", "sw"); b.type = "button"; b.setAttribute("role", "switch"); b.setAttribute("aria-checked", on ? "true" : "false"); b.setAttribute("aria-label", "view: " + s.view);
    b.innerHTML = '<span class="sw-name' + (on ? "" : " cur") + '">table</span><span class="sw-track"><span class="sw-knob"></span></span><span class="sw-name' + (on ? " cur" : "") + '">roomy</span>';
    b.onclick = function () { s.view = on ? "table" : "roomy"; renderResults(); };
    vr.appendChild(b);
    var out = $("results");
    if (s.msg && !s.settings) { out.innerHTML = '<div class="err">' + esc(s.msg) + "</div>"; return; }
    if (!s.hits.length) {
      out.innerHTML = '<div class="empty">' + (!s.st || !s.st.current ? "add a source to start." : s.q.trim() && s.searched ? "no matches. try fewer words, or turn a filter off." : "type a word or a question, press Enter.") + "</div>";
      return;
    }
    var cur = s.hits.filter(function (h) { return h.path === s.open; })[0];
    var list = s.view === "table" ? table() : roomy();
    out.innerHTML = '<div class="split' + (cur ? " open" : "") + '"><div class="scroll">' + list + "</div>" +
      (cur ? '<aside aria-label="side view">' + pane(cur) + "</aside>" : "") + '</div><p class="dim">hover = quick look · click = side view · Esc closes</p>';
    Array.prototype.forEach.call(out.querySelectorAll("[data-i]"), function (n) {
      var i = +n.dataset.i, h = s.hits[i];
      n.onmouseenter = function (e) { if (s.view === "table") showTip(h, e); };
      n.onmouseleave = hideTip;
      n.onclick = function () { openHit(i); };
      n.onkeydown = function (e) { if (e.key === "Enter") openHit(i); };
    });
    var eb = out.querySelector("[data-editor]");
    if (eb && cur) eb.onclick = function () { openInEditor(cur, eb, out.querySelector("[data-editor-note]")); };
    var x = out.querySelector("[data-close]"); if (x) x.onclick = function () { s.open = null; renderResults(); };
    var m = out.querySelector("[data-more]"); if (m) m.onclick = function () { s.openOthers = !s.openOthers; renderResults(); };
  }
  function openHit(i) {
    var h = s.hits[i];
    s.open = s.open === h.path ? null : h.path; s.openOthers = false;
    if (s.open) api("POST", "/api/log", { q: s.q, path: h.path, rank: i + 1 }).catch(function () { /* the log is best-effort */ });
    renderResults();
  }
  function table() {
    return '<table><thead><tr><th>kind</th><th>score</th><th>kw</th><th>repo</th><th class="hide-sm">folder</th><th>file:line</th></tr></thead><tbody>' +
      s.hits.map(function (h, i) {
        return '<tr class="hit' + (s.open === h.path ? " cur" : "") + (h.noisy && s.demote ? " noisy" : "") + '" data-i="' + i + '" tabindex="0"><td class="k-' + esc(h.kind) + '">' + esc(h.kind) + "</td><td>" + h.score.toFixed(2) + "</td><td>" +
          (h.keyword ? '<span class="kw">✓</span>' : '<span class="mo">~</span>') + '</td><td class="sym">' + esc(h.repo) + '</td><td class="dim hide-sm">' + esc(h.folder) + "</td><td>" + loc(h) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  function roomy() {
    return s.hits.slice(0, 5).map(function (h, i) {
      return '<article class="hit' + (s.open === h.path ? " cur" : "") + (h.noisy && s.demote ? " noisy" : "") + '" data-i="' + i + '" tabindex="0"><div class="dim">' + (i + 1) + ". " + esc(h.repo) + " › " + esc(h.folder) +
        '</div><div class="title">' + esc(h.file) + ' <span class="dim">lines ' + h.start + "–" + h.end + "</span></div>" + (h.symbol ? '<div class="sym">§ ' + esc(h.symbol) + "</div>" : "") +
        "<pre>" + h.preview.map(function (l) { return esc(l.t); }).join("\n") + '</pre><div class="dim"><span class="k-' + esc(h.kind) + '">' + esc(h.kind) + "</span> · " + h.score.toFixed(2) + " · " + marker(h) + (h.more ? " · +" + h.more + " more" : "") + "</div></article>";
    }).join("");
  }
  function pane(h) {
    var lines = h.preview.map(function (l) { return '<span class="dim">' + String(l.n).padStart(4) + "  </span>" + esc(l.t); }).join("\n");
    return '<div class="between-line"><span class="dim">' + esc(h.path) + '</span><button class="lnk dim" data-close aria-label="close side view">✕</button></div>' +
      "<div>" + (h.symbol ? '<span class="sym">§ ' + esc(h.symbol) + "</span> " : "") + '<span class="dim">lines ' + h.start + "–" + h.end + "</span></div>" +
      '<div class="dim"><span class="k-' + esc(h.kind) + '">' + esc(h.kind) + "</span> · " + h.score.toFixed(2) + " · " + (h.keyword ? '<span class="kw">kw</span>' : '<span class="mo">~meaning</span>') + "</div>" +
      '<pre class="code">' + lines + "</pre>" +
      (h.more ? '<button class="lnk" data-more>+' + h.more + " more sections in this file</button><br>" : "") +
      (h.more && s.openOthers ? '<div class="others">' + h.others.map(function (o) { return '<a href="' + esc(viewUrl(h, o.start, o.end)) + '">' + esc(o.symbol || "lines") + ' <span class="dim">' + o.start + "–" + o.end + "</span></a>"; }).join("") + "</div>" : "") +
      '<a href="' + esc(viewUrl(h, h.start, h.end)) + '">open full file</a> · <button class="lnk" data-editor>open in pycharm</button><span data-editor-note></span>';
  }
  function showTip(h, e) {
    tip.innerHTML = '<div class="dim">' + esc(h.repo) + "/" + esc(h.folder) + "/" + esc(h.file) + "</div><div>" + (h.symbol ? '<span class="sym">§ ' + esc(h.symbol) + "</span> " : "") +
      '<span class="dim">lines ' + h.start + "–" + h.end + '</span></div><div><span class="k-' + esc(h.kind) + '">' + esc(h.kind) + "</span> · score " + h.score.toFixed(2) + " · " + marker(h) + (h.more ? " · +" + h.more + " more sections" : "") +
      "</div><pre>" + h.preview.map(function (l) { return esc(l.t); }).join("\n") + "</pre>";
    tip.style.display = "block";
    var r = e.currentTarget.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(r.left + 40, innerWidth - 440)) + "px"; tip.style.top = (r.bottom + 4) + "px";
  }
  function hideTip() { tip.style.display = "none"; }

  // ---- URL state: the hash holds the search, so Back / reload / bookmark restore it ---------------------
  var scrollTimer = null;
  function sync(push) {
    var h = ST.encodeState(s);
    if (h === location.hash || (!h && !location.hash)) return;
    history[push ? "pushState" : "replaceState"](push ? null : history.state, "", location.pathname + location.search + h);
  }
  function applyHash() {
    var d = ST.decodeState(location.hash);
    s.q = d.q; s.sub = d.sub; s.ext = d.ext; s.folder = d.folder; s.open = d.open; s.repos = d.repos;
    s.kinds = d.kinds; s.demote = d.demote; s.view = d.view;
    $("q").value = d.q;
  }
  function restoreScroll() {
    var y = history.state && history.state.y;
    if (y) window.scrollTo(0, y);
  }
  window.addEventListener("scroll", function () {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () { history.replaceState({ y: window.scrollY }, "", location.href); }, 100);
  });
  window.addEventListener("popstate", function () { applyHash(); syncQx(); renderFilters(); runSearch().then(restoreScroll); });

  // ---- wiring -------------------------------------------------------------------------------------
  $("q").onkeydown = function (e) {
    if (e.key !== "Enter") return;
    var q = e.target.value;
    // a repo named in the query filters the results to it (the word stays in the query, searched as typed)
    if (q !== s.sub) {
      var names = (s.st && s.st.current && s.st.current.repoNames) || [];
      if (s.st && s.st.current && s.st.current.mode === "repos") s.repos = ST.mergeRepos(s.repos, names, q);
      s.sub = q; s.open = null; s.folder = null; s.ext = null;
    }
    s.q = q; sync(true); runSearch();
  };
  // × in the search box: clears the query text only (repos, docs/code, old/tests last stay); the per-search
  // type/folder suggestions go with the results they came from
  function syncQx() { $("qx").hidden = !$("q").value; }
  $("q").addEventListener("input", syncQx);
  $("qx").onclick = function () {
    var q = $("q"); q.value = ""; s.q = ""; s.sub = ""; s.open = null; s.folder = null; s.ext = null; s.facets = { exts: [], folders: [] };
    syncQx(); sync(true); renderFilters(); runSearch(); q.focus();
  };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && s.open) { s.open = null; renderResults(); } });
  applyHash();
  syncQx();
  renderResults();
  refresh().then(restoreScroll);
})();
