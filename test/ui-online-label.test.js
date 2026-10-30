// The top-bar online/offline label and the never-stopping heartbeat in src/ui/web/app.js. The page is a browser classic
// script, so it runs here against a small fake DOM, a scripted fetch and a fake timer queue (nothing real is waited on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const web = (f) => readFileSync(new URL(`../src/ui/web/${f}`, import.meta.url), "utf8");

/** A recording stand-in for a DOM element: just enough for app.js (innerHTML, children, attributes, outerHTML). */
function fakeDom(writes) {
  const byId = new Map();
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this._html = ""; this._text = ""; this.className = ""; this.value = ""; this.hidden = false; this._id = ""; }
    get id() { return this._id; }
    set id(v) { this._id = v; byId.set(v, this); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); if (this._id === "onlineDot") writes.push(this.className + "|" + this._text); }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = v; this.children = []; }
    get firstChild() { return this.children[0] || null; }
    get outerHTML() { return `<${this.tag} id="${this._id}" class="${this.className}">${this._text}${this._html}${this.children.map((c) => c.outerHTML).join("")}</${this.tag}>`; }
    appendChild(c) { this.children = this.children.filter((x) => x !== c); this.children.push(c); return c; }
    insertBefore(c, ref) { this.children = this.children.filter((x) => x !== c); const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  const document = {
    body: new El("body"), documentElement: new El("html"), title: "", activeElement: null,
    createElement: (t) => new El(t), createTextNode: (t) => { const n = new El("#text"); n._text = String(t); return n; },
    getElementById: (id) => byId.get(id) || null, addEventListener() {},
  };
  for (const id of ["app", "title", "top", "panel", "q", "qx", "filters", "viewrow", "results"]) if (!byId.has(id)) { const e = new El("div"); e.id = id; }
  return { document, byId };
}

const STATE = (over = {}) => ({ version: "9.9.9", active: "r", sources: [{ name: "r", path: "/r", mode: "repo", repos: 1 }],
  current: { name: "r", files: 3, modeText: "keywords", embeddings: false, indexing: false, ...over } });
const SEARCH = { hits: [], facets: { exts: [], folders: [] }, ms: 1 };

/**
 * Boot app.js (or `src`, a mutated copy) against fakes. `mode` picks what fetch does:
 *  ok | 500 | badbody | down | nullsources (200 with `sources: null`, which makes loadState throw while rendering) | busy
 */
async function boot(mode = "ok", src = web("app.js")) {
  const writes = [], timers = [], calls = [];
  const m = { mode };
  const { document, byId } = fakeDom(writes);
  const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new SyntaxError("bad")) : Promise.resolve(body)) });
  const fetch = (url) => {
    calls.push(url);
    if (m.mode === "down") return Promise.reject(new TypeError("Failed to fetch"));
    if (m.mode === "500") return reply(500, { error: "boom" });
    if (m.mode === "badbody") return reply(200, undefined);
    if (url.startsWith("/api/search")) return reply(200, SEARCH);
    if (m.mode === "nullsources") return reply(200, { ...STATE(), sources: null });
    return reply(200, STATE({ indexing: m.mode === "busy" }));
  };
  const window = { addEventListener() {}, scrollTo() {}, scrollY: 0 };
  const ctx = vm.createContext({
    window, document, fetch, URLSearchParams, console: { error() {}, log() {} }, innerWidth: 1000,
    location: { hash: "", pathname: "/", search: "" }, history: { state: null, replaceState() {}, pushState() {} },
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; }, setInterval: () => 0, clearInterval() {},
  });
  vm.runInContext(web("state.js"), ctx);
  vm.runInContext(src, ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const pending = () => timers.filter((t) => t.live);
  /** fire the one waiting heartbeat tick, then let its promises settle */
  const fire = async () => { const t = pending(); assert.equal(t.length, 1, "exactly one chain: " + t.length + " waiting"); t[0].live = false; t[0].fn(); await flush(); };
  await flush();
  writes.length = 0;                          // the label's own construction is not a repaint
  return { m, writes, timers, calls, byId, pending, fire, flush, dot: byId.get("onlineDot"), top: byId.get("top") };
}

test("the label starts online and sits first in the top bar's right-hand controls", async () => {
  const p = await boot("ok");
  assert.equal(p.dot.className, "on");
  assert.equal(p.dot.textContent, "● online");
  assert.equal(p.dot.getAttribute("role"), "status");
  const right = p.top.children[0].children[1];
  assert.equal(right.children[0], p.dot, "left of re-index / sources / theme");
});

test("a 200, a 500 and a 200 with an unparseable body all paint online (the server answered)", async () => {
  for (const mode of ["ok", "500", "badbody"]) {
    const p = await boot(mode);
    await p.fire();
    assert.equal(p.dot.className, "on", mode);
    assert.deepEqual(p.writes, [], mode + ": never rewritten");
  }
});

test("a rejected fetch paints offline; the next reply brings it back by itself", async () => {
  const p = await boot("ok");
  p.m.mode = "down"; await p.fire();
  assert.equal(p.dot.className, "off"); assert.equal(p.dot.textContent, "● offline");
  p.m.mode = "ok"; await p.fire();
  assert.equal(p.dot.className, "on"); assert.equal(p.dot.textContent, "● online");
  assert.deepEqual(p.writes, ["off|● offline", "on|● online"]);
});

test("the same state twice writes the label once", async () => {
  const p = await boot("ok");
  p.m.mode = "down"; await p.fire(); await p.fire(); await p.fire();
  assert.deepEqual(p.writes, ["off|● offline"]);
  p.m.mode = "ok"; await p.fire(); await p.fire();
  assert.equal(p.writes.length, 2);
});

test("delays: idle 10000 (state only, no search), busy 1500, unreachable 3000", async () => {
  const p = await boot("ok");
  assert.equal(p.pending()[0].ms, 10000);
  const before = p.calls.length;
  await p.fire();
  assert.deepEqual(p.calls.slice(before), ["/api/sources"], "the idle tick only loads state");
  assert.equal(p.pending()[0].ms, 10000);
  p.m.mode = "busy"; await p.fire();
  assert.equal(p.pending()[0].ms, 1500);
  p.m.mode = "down"; await p.fire();
  assert.equal(p.pending()[0].ms, 3000);
  const b = await boot("busy");
  assert.equal(b.pending()[0].ms, 1500);
  const d = await boot("down");
  assert.equal(d.pending()[0].ms, 3000, "unreachable at load: the chain is still running");
  assert.equal(d.dot.className, "off");
  assert.ok(d.top.children.length, "the bar (and its label) is drawn even though the first load failed");
});

test("a finished pass re-runs the search once; an unreachable server adds no error banner", async () => {
  const p = await boot("busy");
  p.byId.get("q").onkeydown({ key: "Enter", target: { value: "x" } }); await p.flush();
  let k = p.calls.length; p.m.mode = "busy"; await p.fire();
  assert.deepEqual(p.calls.slice(k), ["/api/sources"], "still running: state only");
  k = p.calls.length; p.m.mode = "ok"; await p.fire();
  assert.deepEqual(p.calls.slice(k).map((u) => u.split("?")[0]), ["/api/sources", "/api/search"], "pass finished: search re-run once");
  p.m.mode = "down"; await p.fire();
  assert.equal(p.byId.get("results").innerHTML.includes("err"), false, "label only, no red banner");
  assert.equal(p.dot.className, "off");
});

test("a tick whose refresh throws still schedules the next one and never paints offline", async () => {
  const p = await boot("ok");
  p.m.mode = "nullsources";
  const n = p.timers.length;                 // count only what is scheduled AFTER the throw
  await p.fire();
  assert.equal(p.timers.length - n, 1, "next tick scheduled after the throw");
  assert.equal(p.pending().length, 1);
  assert.equal(p.dot.className, "on");
  assert.ok(!p.writes.some((w) => w.startsWith("off")), "a render error is not 'offline'");
  // and the other direction: a reply that then breaks the render still means the server is up
  p.m.mode = "down"; await p.fire(); assert.equal(p.dot.className, "off");
  p.m.mode = "nullsources"; await p.fire();
  assert.equal(p.dot.className, "on", "painted by the helper on the reply, before any render could throw");
});

test("starting a pass (re-index click) pulls the waiting idle tick forward; never a second chain", async () => {
  const p = await boot("ok");
  const idle = p.pending()[0];
  assert.equal(idle.ms, 10000);
  const right = p.top.children[0].children[1];
  const btn = right.children.find((c) => c.textContent.includes("re-index"));
  p.m.mode = "busy"; btn.onclick(); await p.flush();
  assert.equal(idle.live, false, "the waiting 10 s tick was cleared");
  assert.equal(p.pending().length, 1, "one chain");
  assert.equal(p.pending()[0].ms, 1500);
});
