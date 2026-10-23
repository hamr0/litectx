// `litectx ui` — integration tests (docs/wiki/local-ui.md). Real temp git repos, a real server on port 0,
// a temp settings file via LITECTX_UI_CONFIG. Behaviour over HTTP, plus the security guards: each one has
// a test that goes red if the guard is removed (mutation-checked when this file was written).

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Database from "better-sqlite3";
import { LiteCtx } from "../src/index.js";
import { createUi } from "../src/ui/server.js";
import { detectMode } from "../src/ui/config.js";
import { isNoisy, search } from "../src/ui/search.js";

const BIN = fileURLToPath(new URL("../bin/litectx.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "litectx-ui-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** @param {string} dir @param {Record<string,string>} files */
function repo(dir, files) {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.dev");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  g("add", "-A");
  g("commit", "-qm", "init");
}

let n = 0;
/** a fresh scratch dir + settings file per test */
function scratch() {
  const dir = join(tmp, `t${++n}`);
  mkdirSync(dir, { recursive: true });
  process.env.LITECTX_UI_CONFIG = join(dir, "cfg", "ui.json");
  return dir;
}
const cfg = () => JSON.parse(readFileSync(/** @type {string} */ (process.env.LITECTX_UI_CONFIG), "utf8"));
beforeEach(() => {
  delete process.env.LITECTX_UI_CONFIG;
});

/** low-level request so Host / Origin can be forged (fetch forbids them) */
function req(ui, method, path, { headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const raw = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    // explicit length: node sends a DELETE body un-framed otherwise, which the server's parser rejects
    if (raw !== undefined) headers = { "content-length": Buffer.byteLength(raw), ...headers };
    const r = http.request({ host: "127.0.0.1", port: ui.port, method, path, headers }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => ok({ status: res.statusCode, text: t, json: () => JSON.parse(t) }));
    });
    r.on("error", fail);
    r.end(raw);
  });
}
const post = (ui, path, body, headers) => req(ui, "POST", path, { body, headers: { "content-type": "application/json", ...headers } });
const get = (ui, path, headers) => req(ui, "GET", path, { headers });
const find = async (ui, q, extra = "") => (await get(ui, `/api/search?q=${encodeURIComponent(q)}${extra}`)).json();

/** an all-repos tree: alpha (docs + code + archive/tests noise), beta (docs), non-repo dir, loose file */
function manyRepos() {
  const root = join(scratch(), "projects");
  repo(join(root, "alpha"), {
    "README.md": "# Alpha\n\nIntro text.\n\n## Quokka care\n\nquokka feeding notes\n\n## Quokka history\n\nquokka history notes quokka\n\n## Misc\n\nnothing\n",
    "src/zoo.js": "export function quokkaKeeper() {\n  return 'quokka';\n}\n",
    "archive/old.md": "# Old\n\nquokka quokka quokka quokka quokka quokka quokka quokka\n",
    "tests/zoo.test.js": "// quokka quokka quokka quokka quokka quokka\nexport function quokkaTest() {}\n",
  });
  repo(join(root, "beta"), { "docs/guide.md": "# Guide\n\nquokka guide for beta\n" });
  mkdirSync(join(root, "plain"));
  writeFileSync(join(root, "plain", "x.md"), "# Plain\n\nquokka plain\n");
  return root;
}

// ---- mode detection ---------------------------------------------------------------------------------

test("mode detection: repo, folder of repos, neither, bad paths", () => {
  const root = manyRepos();
  assert.deepEqual(detectMode(join(root, "alpha")), { ok: true, mode: { mode: "repo", repos: 1 } });
  assert.deepEqual(detectMode(root), { ok: true, mode: { mode: "repos", repos: 2 } });
  const r = detectMode(join(root, "plain"));
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).error, /no git repos found/);
  assert.equal(detectMode(".").ok, false, "a relative path is refused even when it is a repo (cwd is the litectx checkout)");
  assert.equal(detectMode("relative/dir").ok, false);
  assert.equal(detectMode(join(root, "nope")).ok, false);
  assert.equal(detectMode(join(root, "alpha", "README.md")).ok, false); // a file, not a dir
});

test("startup banner reports the mode; a folder of repos is searched as one combined index", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0, path: root });
  try {
    assert.match(ui.describe(), /mode: all repos \(2 found\)/);
    await ui.idle();
    assert.ok(existsSync(join(root, ".litectx", "index.db")), "combined index lives at <folder>/.litectx/index.db");
    const r = await find(ui, "quokka", "&demote=0");
    assert.ok(r.hits.some((h) => h.path.startsWith("beta/")));
    assert.ok(!r.hits.some((h) => h.path.startsWith("plain/")), "a non-repo dir is never read");
  } finally {
    await ui.close();
  }
});

test("a path that is neither a repo nor a folder of repos is rejected with a clear message", async () => {
  const root = manyRepos();
  await assert.rejects(createUi({ port: 0, path: join(root, "plain") }), /no git repos found/);
  assert.equal(existsSync(/** @type {string} */ (process.env.LITECTX_UI_CONFIG)), false, "nothing persisted for a rejected path");
});

// ---- sources ----------------------------------------------------------------------------------------

test("sources: add, switch, remove are persisted; bad paths are 400", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0 });
  try {
    assert.deepEqual((await get(ui, "/api/sources")).json().sources, [], "first run: no sources, the page shows the Add form");

    let r = await post(ui, "/api/sources", { name: "a", path: join(root, "alpha") });
    assert.equal(r.status, 200);
    assert.equal(r.json().active, "a");
    assert.equal(r.json().sources[0].mode, "repo");
    await ui.idle();
    r = await post(ui, "/api/sources", { name: "all", path: root });
    assert.equal(r.json().sources[1].mode, "repos");
    assert.deepEqual(cfg(), { active: "all", sources: [{ name: "a", path: join(root, "alpha") }, { name: "all", path: root }] });

    assert.equal((await post(ui, "/api/sources", { name: "a", path: join(root, "beta") })).status, 409, "duplicate name");
    assert.equal((await post(ui, "/api/sources", { name: "rel", path: "relative/dir" })).status, 400, "path must be absolute");
    assert.equal((await post(ui, "/api/sources", { name: "gone", path: join(root, "nope") })).status, 400, "path must exist");
    assert.equal((await post(ui, "/api/sources", { name: "pl", path: join(root, "plain") })).status, 400, "no git repos");
    assert.equal(cfg().sources.length, 2, "rejected adds are not persisted");

    await post(ui, "/api/sources", { active: "a" });
    assert.equal(cfg().active, "a");
    assert.equal((await post(ui, "/api/sources", { active: "zzz" })).status, 404);

    r = await req(ui, "DELETE", "/api/sources", { body: { name: "a" }, headers: { "content-type": "application/json" } });
    assert.equal(r.status, 200);
    assert.deepEqual(cfg().sources.map((s) => s.name), ["all"]);
    assert.equal(cfg().active, "all", "removing the active source falls back to the next one");
  } finally {
    await ui.close();
  }
});

test("remove never deletes a one-repo index; an all-repos index goes only when asked", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0 });
  const del = (body) => req(ui, "DELETE", "/api/sources", { body, headers: { "content-type": "application/json" } });
  try {
    await post(ui, "/api/sources", { name: "a", path: join(root, "alpha") });
    await ui.idle();
    const one = join(root, "alpha", ".litectx", "index.db");
    assert.ok(existsSync(one));
    await del({ name: "a", deleteIndex: true }); // even when asked: agents use this file
    assert.ok(existsSync(one), "one-repo index survives removal");

    await post(ui, "/api/sources", { name: "all", path: root });
    await ui.idle();
    const many = join(root, ".litectx", "index.db");
    assert.ok(existsSync(many));
    await del({ name: "all", deleteIndex: false });
    assert.ok(existsSync(many), "unticked box keeps the combined index");
    await post(ui, "/api/sources", { name: "all", path: root });
    await ui.idle();
    await del({ name: "all", deleteIndex: true });
    assert.ok(!existsSync(many), "ticked box deletes the combined index");
  } finally {
    await ui.close();
  }
});

test("the CLI path argument reuses an existing source for the same path", async () => {
  const root = manyRepos();
  let ui = await createUi({ port: 0, path: join(root, "alpha") });
  await ui.idle();
  await ui.close();
  ui = await createUi({ port: 0, path: join(root, "alpha") });
  try {
    assert.equal(cfg().sources.length, 1);
    assert.equal(cfg().sources[0].name, "alpha");
  } finally {
    await ui.close();
  }
});

// ---- search -----------------------------------------------------------------------------------------

test("search JSON: shape, 1-based lines that match the API's 0-based chunk, 3-line preview, grouping", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0, path: root });
  try {
    await ui.idle();
    const r = await find(ui, "quokka", "&demote=0");
    const h = r.hits.find((x) => x.path === "alpha/src/zoo.js");
    assert.ok(h);
    for (const k of ["repo", "folder", "file", "path", "abs", "kind", "score", "keyword", "symbol", "start", "end", "preview", "more", "others"]) assert.ok(k in h, k);
    assert.equal(h.repo, "alpha");
    assert.equal(h.folder, "src");
    assert.equal(h.file, "zoo.js");
    assert.equal(h.kind, "code");
    assert.equal(h.abs, join(root, "alpha/src/zoo.js"));
    // ground truth: the library's own (0-based) chunk, +1 for humans
    const ctx = new LiteCtx({ root, childRepos: true });
    const lib = (await ctx.recall("quokka", { kind: "code", n: 20 })).find((x) => x.path === "alpha/src/zoo.js");
    ctx.close();
    assert.equal(h.start, /** @type {any} */ (lib).chunk.startLine + 1);
    assert.equal(h.end, /** @type {any} */ (lib).chunk.endLine + 1);
    assert.equal(h.start, 1);
    assert.deepEqual(h.preview[0], { n: 1, t: "export function quokkaKeeper() {" });
    assert.ok(h.preview.length <= 3);

    // knob 1: one entry per file; the other matching sections are counted
    const paths = r.hits.map((x) => x.path);
    assert.equal(new Set(paths).size, paths.length, "no file twice");
    const readme = r.hits.find((x) => x.path === "alpha/README.md");
    assert.ok(readme.more >= 1, "README has several quokka sections");
    assert.equal(readme.others.length, readme.more);
    assert.ok(readme.start >= 1 && readme.end >= readme.start);

    const raw = await find(ui, "quokka", "&demote=0&group=0");
    assert.ok(raw.hits.filter((x) => x.path === "alpha/README.md").length >= 2, "grouping off = every section on its own");
  } finally {
    await ui.close();
  }
});

test("knob 2: old/tests last moves archive|poc|test|tests|logs and .test. files to the end, order otherwise kept", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0, path: root });
  try {
    await ui.idle();
    const off = (await find(ui, "quokka", "&demote=0")).hits.map((h) => h.path);
    const on = (await find(ui, "quokka", "&demote=1")).hits.map((h) => h.path);
    const noisy = (p) => /(^|\/)(archive|tests)\//.test(p) || p.includes(".test.");
    assert.ok(noisy(off[0]), `precondition: noise ranks first without the knob (got ${off[0]})`);
    assert.deepEqual([...on].sort(), [...off].sort(), "same set");
    const firstNoisy = on.findIndex(noisy);
    assert.ok(firstNoisy > 0);
    assert.ok(on.slice(firstNoisy).every(noisy), "everything after the first noisy file is noisy");
    assert.deepEqual(on.filter((p) => !noisy(p)), off.filter((p) => !noisy(p)), "clean files keep their order");
    assert.deepEqual(on.filter(noisy), off.filter(noisy), "noisy files keep their order");
  } finally {
    await ui.close();
  }
});

test("repo filter, kinds filter, extension, and folder filters", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0, path: root });
  try {
    await ui.idle();
    const beta = await find(ui, "quokka", "&repos=beta");
    assert.deepEqual(beta.hits.map((h) => h.repo), ["beta"], "only beta's hit");
    const both = await find(ui, "quokka", "&repos=beta,alpha&demote=0");
    assert.deepEqual([...new Set(both.hits.map((h) => h.repo))].sort(), ["alpha", "beta"]);
    // the query is searched as typed: a repo word in the query stays in it (and matches path tokens)
    assert.ok((await find(ui, "beta quokka", "&repos=beta")).hits.every((h) => h.repo === "beta"));

    const docs = await find(ui, "quokka", "&kinds=doc");
    assert.ok(docs.hits.length && docs.hits.every((h) => h.kind === "doc"));
    const code = await find(ui, "quokka", "&kinds=code");
    assert.ok(code.hits.length && code.hits.every((h) => h.kind === "code"));

    const all = await find(ui, "quokka");
    assert.deepEqual(all.facets.exts, ["js", "md"]);
    assert.ok(all.facets.folders.includes("src"));
    assert.ok((await find(ui, "quokka", "&ext=js")).hits.every((h) => h.file.endsWith(".js")));
    assert.ok((await find(ui, "quokka", "&folder=src")).hits.every((h) => h.folder === "src"));
    assert.deepEqual((await find(ui, "   ")).hits, [], "blank query = no results");
  } finally {
    await ui.close();
  }
});

test("one-repo mode: repo is the source name, paths carry no prefix", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0, path: join(root, "alpha") });
  try {
    await ui.idle();
    const r = await find(ui, "quokka");
    const h = r.hits.find((x) => x.path === "src/zoo.js");
    assert.ok(h);
    assert.equal(h.repo, "alpha");
    assert.equal(h.folder, "src");
    assert.ok((await get(ui, "/api/sources")).json().current.repoNames.includes("alpha"));
  } finally {
    await ui.close();
  }
});

test("re-index is incremental and picks up new files", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0, path: root });
  try {
    await ui.idle();
    assert.equal((await find(ui, "wombat")).hits.length, 0);
    writeFileSync(join(root, "beta", "wombat.md"), "# W\n\nwombat\n");
    execFileSync("git", ["-C", join(root, "beta"), "add", "wombat.md"]);
    const r = await post(ui, "/api/reindex", { wait: true });
    assert.equal(r.status, 200);
    const last = r.json().current.last;
    assert.equal(last.added, 1);
    assert.ok(last.unchanged >= 5, "unchanged files were skipped, not re-read");
    assert.equal((await find(ui, "wombat")).hits.length, 1);
  } finally {
    await ui.close();
  }
});

// Over a stub recall, so the name rules are pinned where the input can be controlled.
test("search transforms over stub hits: noisy-path rules, repo prefix is not a dir segment", async () => {
  const hit = (path, keyword = true) => ({ path, kind: "code", format: "js", score: 1, keyword, chunk: { symbol: null, nodeType: "file", startLine: 0, endLine: 0 } });
  const hits = [hit("poc/a.js"), hit("r/src/b.js", false), hit("r/src/c.test.js"), hit("r/src/d.js")];
  const ctx = /** @type {any} */ ({ recall: async () => ({ doc: [], code: hits }) });
  const run = (o) => search(ctx, "/nowhere", "repos", "x", "q", o).then((r) => r.rows.map((h) => h.path));
  assert.deepEqual(await run({ demote: false }), ["poc/a.js", "r/src/b.js", "r/src/c.test.js", "r/src/d.js"]);
  // `poc` here is a REPO name (first segment), not a directory: it must not be demoted
  assert.deepEqual(await run({}), ["poc/a.js", "r/src/b.js", "r/src/d.js", "r/src/c.test.js"], "only the .test. file moves to the end");
  assert.equal(isNoisy(["src"], "c.test.js"), true, ".test. in the file name");
  assert.equal(isNoisy(["src"], "d.js"), false);
  for (const d of ["archive", "poc", "test", "tests", "logs"]) assert.equal(isNoisy(["a", d], "f.md"), true, d);
});

// ---- /view confinement ------------------------------------------------------------------------------

test("/view serves a file with the range highlighted, HTML-escaped; rejects ../ and symlink escapes", async () => {
  const root = join(scratch(), "r");
  const secret = join(scratch(), "secret.txt");
  writeFileSync(secret, "TOP-SECRET-CONTENT\n");
  repo(root, { "a.md": "# A\n\nline <script>alert(1)</script> one\nline two\n", "b.js": "export const b = 1;\n" });
  writeFileSync(join(root, ".env"), "API_KEY=UNTRACKED-SECRET\n"); // inside the root, never git-added
  symlinkSync(secret, join(root, "link.md")); // tracked symlink pointing OUTSIDE the root
  execFileSync("git", ["-C", root, "add", "link.md"]);
  const ui = await createUi({ port: 0, path: root });
  try {
    await ui.idle();
    const ok = await get(ui, "/view?p=a.md&s=3&e=4");
    assert.equal(ok.status, 200);
    assert.match(ok.text, /<div id="L3" class="ln on">/);
    assert.match(ok.text, /<div id="L4" class="ln on">/);
    assert.match(ok.text, /<div id="L2" class="ln">/);
    assert.ok(!ok.text.includes("<script>alert(1)"), "file text is HTML-escaped");
    assert.ok(ok.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));

    for (const bad of ["../secret.txt", "../../etc/passwd", "a.md/../../secret.txt", "..%2Fsecret.txt"]) {
      const r = await get(ui, `/view?p=${bad.startsWith("..%") ? bad : encodeURIComponent(bad)}`);
      assert.ok(r.status === 403 || r.status === 404, `${bad} → ${r.status}`);
      assert.ok(!r.text.includes("TOP-SECRET"), `${bad} leaked`);
    }
    // only INDEXED files are served: an untracked file inside the root is refused, however it is spelled
    for (const p of [".env", "./.env", "x/../.env"]) {
      const r = await get(ui, "/view?p=" + encodeURIComponent(p));
      assert.equal(r.status, 404, `${p} → ${r.status}`);
      assert.ok(!r.text.includes("UNTRACKED-SECRET"), `${p} leaked`);
    }
    assert.equal((await get(ui, "/view?p=./b.js")).status, 200, "an indexed file opens under a non-canonical spelling");
    const link = await get(ui, "/view?p=link.md");
    assert.equal(link.status, 403, "symlink escape rejected");
    assert.ok(!link.text.includes("TOP-SECRET"));
    assert.equal((await get(ui, "/view?p=" + encodeURIComponent(secret))).status, 403, "absolute path outside the root");
  } finally {
    await ui.close();
  }
});

// ---- network guards ---------------------------------------------------------------------------------

test("the server binds 127.0.0.1 only", async () => {
  scratch();
  const ui = await createUi({ port: 0 });
  try {
    const a = /** @type {any} */ (ui.url);
    assert.match(a, /^http:\/\/127\.0\.0\.1:\d+$/);
    // a connection through a non-loopback address of this machine must not be accepted
    const { networkInterfaces } = await import("node:os");
    const other = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4");
    if (other) {
      const refused = await new Promise((ok) => {
        const r = http.request({ host: other.address, port: ui.port, path: "/api/sources", timeout: 1500 }, () => ok(false));
        r.on("error", () => ok(true));
        r.on("timeout", () => { r.destroy(); ok(true); });
        r.end();
      });
      assert.ok(refused, `reachable via ${other.address}`);
    }
  } finally {
    await ui.close();
  }
});

test("Host header allow-list (DNS rebinding)", async () => {
  scratch();
  const ui = await createUi({ port: 0 });
  try {
    assert.equal((await get(ui, "/api/sources")).status, 200);
    assert.equal((await get(ui, "/api/sources", { host: `localhost:${ui.port}` })).status, 200);
    for (const h of ["evil.example.com", `evil.example.com:${ui.port}`, "127.0.0.1", `127.0.0.1:${ui.port + 1}`, `127.0.0.1.evil.com:${ui.port}`]) {
      const r = await get(ui, "/api/sources", { host: h });
      assert.equal(r.status, 403, h);
    }
    assert.equal((await get(ui, "/", { host: "evil.example.com" })).status, 403, "the page too");
  } finally {
    await ui.close();
  }
});

test("Origin check: state-changing requests from another origin are refused and change nothing", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0 });
  try {
    const body = { name: "x", path: join(root, "alpha") };
    for (const origin of ["http://evil.example.com", "null", `http://127.0.0.1:${ui.port + 1}`]) {
      assert.equal((await post(ui, "/api/sources", body, { origin })).status, 403, origin);
    }
    assert.equal((await req(ui, "DELETE", "/api/sources", { body: { name: "x" }, headers: { origin: "http://evil.example.com" } })).status, 403);
    assert.equal((await post(ui, "/api/reindex", {}, { origin: "http://evil.example.com" })).status, 403);
    assert.equal((await post(ui, "/api/log", { q: "q", path: "p", rank: 1 }, { origin: "http://evil.example.com" })).status, 403);
    assert.deepEqual((await get(ui, "/api/sources")).json().sources, [], "nothing was added");
    // same origin (and no Origin at all) is fine
    assert.equal((await post(ui, "/api/sources", body, { origin: `http://127.0.0.1:${ui.port}` })).status, 200);
    assert.equal((await post(ui, "/api/sources", { ...body, name: "y" })).status, 200);
  } finally {
    await ui.close();
  }
});

// ---- click log --------------------------------------------------------------------------------------

test("click log appends one JSONL line per opened result, beside the settings file", async () => {
  const root = manyRepos();
  const ui = await createUi({ port: 0, path: join(root, "alpha") });
  try {
    await ui.idle();
    assert.equal((await post(ui, "/api/log", { q: "quokka care", path: "README.md", rank: 2 })).status, 200);
    assert.equal((await post(ui, "/api/log", { q: "second", path: "src/zoo.js", rank: 1 })).status, 200);
    assert.equal((await post(ui, "/api/log", { q: "bad", path: "x" })).status, 400, "rank required");
    const file = join(/** @type {string} */ (process.env.LITECTX_UI_CONFIG), "..", "ui-log.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]), ["ts", "source", "q", "path", "rank"]);
    assert.equal(lines[0].source, "alpha");
    assert.equal(lines[0].q, "quokka care");
    assert.equal(lines[0].rank, 2);
    assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
    assert.equal(lines[1].path, "src/zoo.js");
  } finally {
    await ui.close();
  }
});

// ---- the page ---------------------------------------------------------------------------------------

test("static assets are served with a locked-down CSP", async () => {
  scratch();
  const ui = await createUi({ port: 0 });
  try {
    for (const [p, type] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/app.css", "text/css"], ["/theme.js", "text/javascript"], ["/state.js", "text/javascript"]]) {
      const r = await get(ui, p);
      assert.equal(r.status, 200, p);
      assert.ok(r.text.length > 50);
    }
    const res = await new Promise((ok) => http.get({ host: "127.0.0.1", port: ui.port, path: "/" }, ok));
    assert.match(res.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    res.resume();
    assert.equal((await get(ui, "/nope")).status, 404);
  } finally {
    await ui.close();
  }
});

// ---- embeddings -------------------------------------------------------------------------------------

test("an embeddings-OFF index pass (the UI default) keeps the vectors an embeddings-ON writer built", async () => {
  const root = join(scratch(), "r");
  repo(root, { "a.md": "# A\n\nalpha text here\n", "b.js": "export function bee() { return 1; }\n", "c.py": "def cee():\n    return 3\n" });
  const dbPath = join(root, ".litectx", "index.db");
  const stub = { embed: async (t) => new Float32Array([t.length, 1, 2, 3]) };
  const count = (tbl) => {
    const db = new Database(dbPath, { readonly: true });
    try { return /** @type {any} */ (db.prepare(`SELECT count(*) AS n FROM ${tbl}`).get()).n; } finally { db.close(); }
  };
  const on = new LiteCtx({ root, embeddings: true, embedder: stub }); // what the CLI / MCP do by default
  await on.index();
  on.close();
  const before = { files: count("file_embeddings"), secs: count("doc_sections WHERE vec IS NOT NULL") };
  assert.ok(before.files >= 2 && before.secs >= 1, "precondition: vectors exist");

  const ui = await createUi({ port: 0, path: root }); // embeddings off
  try {
    await ui.idle();
    assert.equal(count("file_embeddings"), before.files, "file vectors untouched");
    assert.equal(count("doc_sections WHERE vec IS NOT NULL"), before.secs, "section vectors untouched");
    assert.equal((await post(ui, "/api/reindex", { wait: true })).status, 200);
    assert.equal(count("file_embeddings"), before.files, "still untouched after a re-index button press");
    // only a CHANGED file loses its (now stale) vector; the embeddings-ON writer backfills it next pass
    writeFileSync(join(root, "b.js"), "export function bee() { return 2; }\n");
    await post(ui, "/api/reindex", { wait: true });
    assert.equal(count("file_embeddings"), before.files - 1);
  } finally {
    await ui.close();
  }
  const back = new LiteCtx({ root, embeddings: true, embedder: stub });
  await back.index();
  back.close();
  assert.equal(count("file_embeddings"), before.files, "the embeddings-ON writer heals the changed file");
});

// ---- CLI --------------------------------------------------------------------------------------------

test("CLI: `litectx ui <path> --port 0` prints the URL and mode, serves, and a bad path exits 1", async () => {
  const root = manyRepos();
  const env = { ...process.env, LITECTX_UI_CONFIG: /** @type {string} */ (process.env.LITECTX_UI_CONFIG) };
  const p = spawn(process.execPath, [BIN, "ui", root, "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let err = "";
    const url = await new Promise((ok, fail) => {
      p.stderr.on("data", (c) => {
        err += c;
        const m = /http:\/\/127\.0\.0\.1:\d+/.exec(err);
        if (m) ok(m[0]);
      });
      p.on("exit", () => fail(new Error(`exited early: ${err}`)));
    });
    assert.match(err, /mode: all repos \(2 found\)/);
    const html = await (await fetch(`${url}/`)).text();
    assert.match(html, /litectx tinymem/);
  } finally {
    p.kill("SIGINT");
    await new Promise((ok) => p.on("exit", ok));
  }
  const bad = spawn(process.execPath, [BIN, "ui", join(root, "plain"), "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let e2 = "";
  bad.stderr.on("data", (c) => (e2 += c));
  const code = await new Promise((ok) => bad.on("exit", ok));
  assert.equal(code, 1);
  assert.match(e2, /no git repos found/);
});

test("regression: the page and status answer WHILE a cold index pass is running (index runs with yield:true)", async () => {
  const root = join(scratch(), "big");
  /** @type {Record<string,string>} */
  const files = {};
  for (let i = 0; i < 600; i++) files[`src/m${i}.js`] = `export function f${i}(a) {\n  return a + ${i};\n}\nexport class C${i} { m() { return f${i}(1); } }\n`;
  repo(root, files);
  const ui = await createUi({ port: 0, path: root });
  try {
    // the cold pass started during createUi; without yield it would hold the event loop until it finished
    const page = await get(ui, "/");
    assert.equal(page.status, 200);
    assert.match(page.text, /litectx tinymem/);
    const st = (await get(ui, "/api/sources")).json();
    assert.equal(st.current.indexing, true, "status was served mid-pass and says so — the page shows 'indexing…'");
    const s = await find(ui, "f10");
    assert.equal(s.indexing, true, "search is served mid-pass (on the old/partial index) and flags indexing");
    await ui.idle();
    assert.equal((await get(ui, "/api/sources")).json().current.indexing, false);
    assert.ok((await find(ui, "f10")).hits.length > 0);
  } finally {
    await ui.close();
  }
});

// ---- page state <-> URL hash (Back / reload / bookmark restore the search) --------------------------

/** state.js is a browser classic script: run it against a fake window and take what it publishes. */
function pageState() {
  const win = /** @type {any} */ ({});
  vm.runInNewContext(readFileSync(new URL("../src/ui/web/state.js", import.meta.url), "utf8"), { window: win, URLSearchParams });
  return win.litectxState;
}

test("page state round-trips through the URL hash: special chars, several repos, every filter", () => {
  const { encodeState, decodeState: dec } = pageState();
  const decodeState = (h) => JSON.parse(JSON.stringify(dec(h))); // vm objects have another realm's prototypes
  const full = {
    q: 'how to "quote" & #hash? 100% ü 日本', sub: "a b,c", ext: "md", folder: "docs/wiki", open: "my repo/src/a b#c.js",
    repos: ["bare,agent", "x&y=z", "plain"], kinds: { doc: false, code: true }, demote: false, view: "roomy",
  };
  assert.deepEqual(decodeState(encodeState(full)), { ...full });
  const def = { q: "", sub: "", ext: null, folder: null, open: null, repos: [], kinds: { doc: true, code: true }, demote: true, view: "table" };
  assert.equal(encodeState(def), "", "defaults leave the URL clean");
  assert.deepEqual(decodeState(""), def);
  assert.deepEqual(decodeState(encodeState({ ...def, q: "x" })), { ...def, q: "x" });
});

test("the page title line gets litectx's own version from the server (package.json, not hardcoded)", async () => {
  scratch();
  const ui = await createUi({ port: 0 });
  try {
    const st = JSON.parse((await get(ui, "/api/sources")).text);
    assert.equal(st.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    const app = (await get(ui, "/app.js")).text;
    assert.ok(app.includes("lightning local retrieval") && !/v\d+\.\d+\.\d+/.test(app), "no literal version in the page code");
  } finally {
    await ui.close();
  }
});

// ---- repo filters survive a new search; "clear all" ---------------------------------------------------

const J = (v) => JSON.parse(JSON.stringify(v)); // vm objects carry another realm's prototypes

test("repos named in a query are ADDED to the picked ones (deduped), never replace them", () => {
  const { mergeRepos } = pageState();
  const names = ["alpha", "beta", "gamma"];
  assert.deepEqual(J(mergeRepos(["gamma"], names, "alpha docs")), ["gamma", "alpha"], "picked stays, typed is added");
  assert.deepEqual(J(mergeRepos(["alpha"], names, "alpha again")), ["alpha"], "no duplicates");
  assert.deepEqual(J(mergeRepos(["gamma"], names, "nothing here")), ["gamma"], "a query naming no repo keeps the picks");
  assert.deepEqual(J(mergeRepos([], names, "BETA, Alpha")), ["alpha", "beta"], "case-insensitive, in repo order");
});

test("clear all resets every filter, keeps the query, and hasFilters tells when it is needed", () => {
  const { clearFilters, hasFilters, encodeState } = pageState();
  const def = { q: "find me", sub: "find me", ext: null, folder: null, open: null, repos: [], kinds: { doc: true, code: true }, demote: true, view: "table" };
  assert.equal(hasFilters(def), false, "nothing set: the control stays hidden");
  for (const dirty of [{ repos: ["a"] }, { ext: "md" }, { folder: "docs" }, { kinds: { doc: false, code: true } }, { kinds: { doc: true, code: false } }, { demote: false }]) {
    assert.equal(hasFilters({ ...def, ...dirty }), true, JSON.stringify(dirty));
  }
  const s = { ...def, repos: ["a", "b"], ext: "md", folder: "docs", kinds: { doc: false, code: true }, demote: false };
  clearFilters(s);
  assert.deepEqual(J(s), def, "all five back to defaults, query untouched");
  assert.equal(encodeState(s), "#q=find+me&sub=find+me", "the URL hash holds only the query afterwards");
});

test("passText formats the last index pass for the top bar", () => {
  const { passText } = pageState();
  assert.equal(passText({ added: 3, updated: 1, removed: 0, ms: 2140 }), "+3 ~1 -0 · 2.1 s");
  assert.equal(passText(null), "");
});

test("the page wires the Enter handler to mergeRepos and the clear control to clearFilters", async () => {
  scratch();
  const ui = await createUi({ port: 0 });
  try {
    const app = (await get(ui, "/app.js")).text;
    assert.ok(app.includes("ST.mergeRepos(s.repos") && app.includes("ST.clearFilters(s)"));
    assert.ok(!/s\.repos = names\.filter/.test(app), "the replacing assignment is gone");
  } finally {
    await ui.close();
  }
});

test("naming a repo: its docs and code alternate from the top (filter BEFORE the doc/code interleave)", async () => {
  const root = join(scratch(), "two");
  const docs = {};
  for (let i = 0; i < 5; i++) docs[`d${i}.md`] = `# zebra zebra zebra\n\nzebra zebra zebra zebra ${i}\n`;
  repo(join(root, "bravo"), docs); // bravo's docs outrank alpha's globally
  const code = {};
  for (let i = 0; i < 5; i++) code[`c${i}.js`] = `// zebra\nexport function zebra${i}() { return "zebra zebra"; }\n`;
  repo(join(root, "alpha"), { "README.md": "# alpha\n\nthe zebra is mentioned once here among much other prose about nothing relevant\n", ...code });
  const ctx = new LiteCtx({ root, childRepos: true });
  try {
    await ctx.index();
    const rows = (await search(ctx, root, "repos", "two", "zebra", { repos: ["alpha"] })).rows;
    assert.ok(rows.every((r) => r.repo === "alpha"));
    assert.deepEqual(rows.slice(0, 2).map((r) => r.kind).sort(), ["code", "doc"], "first two = one doc + one code of alpha");
  } finally {
    ctx.close();
  }
});

// ---- open in PyCharm: the server launches the editor ----------------------------------------------------

/** a fake editor: an executable script that appends its argv (one arg per line) to a file */
function fakeEditor(dir) {
  const out = join(dir, "argv.txt");
  const bin = join(dir, "fake-editor");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${out}'\n`);
  chmodSync(bin, 0o755);
  return { bin, out };
}
async function waitFor(file) {
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
/** a one-repo server with a fake editor configured; `.env` is on disk but untracked */
async function editorUi(editor) {
  const dir = scratch();
  const root = join(dir, "r");
  repo(root, { "a.js": "export const a = 1;\nexport const b = 2;\n" });
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  const fake = fakeEditor(dir);
  mkdirSync(join(dir, "cfg"), { recursive: true });
  writeFileSync(process.env.LITECTX_UI_CONFIG, JSON.stringify({ active: "r", sources: [{ name: "r", path: root }], editor: editor ?? fake.bin }));
  const ui = await createUi({ port: 0 });
  await ui.idle();
  return { ui, root, fake };
}

test("/api/open launches the configured editor with `--line N <abs path>` (no shell)", async () => {
  const { ui, root, fake } = await editorUi();
  try {
    const r = await post(ui, "/api/open", { path: "a.js", line: 2 });
    assert.equal(r.status, 200, r.text);
    assert.equal(await waitFor(fake.out), `--line\n2\n${join(root, "a.js")}\n`);
    assert.equal(cfg().editor, fake.bin, "editor survives a config rewrite");
    await post(ui, "/api/sources", { path: root }); // a state-changing save must keep the editor field
    assert.equal(cfg().editor, fake.bin);
  } finally {
    await ui.close();
  }
});

test("/api/open refuses an untracked file, an outside path, and a bad line", async () => {
  const { ui, fake } = await editorUi();
  try {
    assert.equal((await post(ui, "/api/open", { path: ".env", line: 1 })).status, 404);
    assert.equal((await post(ui, "/api/open", { path: "../x", line: 1 })).status, 404);
    for (const line of [0, -1, 1.5, "3", null, undefined]) assert.equal((await post(ui, "/api/open", { path: "a.js", line })).status, 400, String(line));
    assert.equal((await post(ui, "/api/open", { line: 1 })).status, 400);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!existsSync(fake.out), "the editor was never started");
  } finally {
    await ui.close();
  }
});

test("/api/open: a foreign Origin is refused and the editor is not started; bad Host too", async () => {
  const { ui, fake } = await editorUi();
  try {
    assert.equal((await post(ui, "/api/open", { path: "a.js", line: 1 }, { origin: "http://evil.example.com" })).status, 403);
    assert.equal((await post(ui, "/api/open", { path: "a.js", line: 1 }, { host: "evil.example.com" })).status, 403);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!existsSync(fake.out), "the editor was never started");
  } finally {
    await ui.close();
  }
});

test("/api/open: a missing editor gives a clear error", async () => {
  const { ui } = await editorUi("/nonexistent/dir/pycharm");
  try {
    const r = await post(ui, "/api/open", { path: "a.js", line: 1 });
    assert.equal(r.status, 404);
    assert.match(r.json().error, /editor '\/nonexistent\/dir\/pycharm' in ~\/\.litectx\/ui\.json is not an executable file/);
  } finally {
    await ui.close();
  }
});

test("resolveEditor: nothing configured and nothing installed says where to set it", async () => {
  const { resolveEditor } = await import("../src/ui/config.js");
  const oldPath = process.env.PATH, oldHome = process.env.HOME;
  process.env.PATH = "/nonexistent-bin";
  process.env.HOME = join(tmp, "nohome");
  try {
    const r = resolveEditor(undefined);
    // /opt and /snap are absolute system locations: only assert the message when none exists here
    if (!existsSync("/opt/pycharm/bin/pycharm") && !existsSync("/snap/bin/pycharm-professional") && !existsSync("/snap/bin/pycharm-community")) {
      assert.deepEqual(r, { ok: false, error: 'PyCharm not found; set "editor" in ~/.litectx/ui.json' });
    }
    writeFileSync(join(tmp, "pycharm"), "#!/bin/sh\n");
    chmodSync(join(tmp, "pycharm"), 0o755);
    process.env.PATH = tmp;
    assert.deepEqual(resolveEditor(undefined), { ok: true, path: join(tmp, "pycharm") }, "found on PATH");
  } finally {
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
  }
});

test("page: filter-line order is fixed (docs, code, old/tests last, repos, types, folders, clear) and × clears the query only", async () => {
  scratch();
  const ui = await createUi({ port: 0 });
  try {
    const app = (await get(ui, "/app.js")).text;
    const at = (needle) => app.indexOf(needle, app.indexOf("function renderFilters"));
    const order = [at('chip("docs"'), at('chip("code"'), at('chip("old/tests last"'), at("repoInput()"), at("s.facets.exts.forEach"), at("s.facets.folders.slice"), at("ST.hasFilters(s)")];
    assert.ok(order.every((i) => i > 0), "all controls present");
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "controls in the fixed order");
    assert.ok(app.includes('aria-label="clear search"') && app.includes("$(\"qx\").onclick"));
    const click = app.slice(app.indexOf('$("qx").onclick'), app.indexOf('document.addEventListener("keydown"'));
    assert.ok(!/s\.repos|s\.kinds|s\.demote/.test(click), "× leaves repos, docs/code and old/tests last alone");
  } finally {
    await ui.close();
  }
});
