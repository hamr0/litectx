// `litectx ui` — a localhost search page. node:http, bound to 127.0.0.1, no dependencies.
// Spec of record: docs/wiki/local-ui.md. Security posture: loopback bind, Host allow-list
// (DNS-rebinding), Origin check on state-changing requests, /view confined by realpath, every rendered
// string HTML-escaped, JSON for the API, and no user input ever reaches a shell.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LiteCtx } from "../index.js";
import { childRepos } from "../indexer.js";
import { detectMode, describeMode, loadConfig, logPath, resolveEditor, saveConfig } from "./config.js";
import { search } from "./search.js";

const MAX_BODY = 64 * 1024;
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const NAME_RE = /^[^\u0000-\u001f]{1,64}$/;

/** @param {unknown} s @returns {string} */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** @param {string} f @returns {string} */
/** litectx's own version, read from its package.json once (never hardcoded). */
const VERSION = /** @type {{ version: string }} */ (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))).version;
const web = (f) => readFileSync(new URL(`./web/${f}`, import.meta.url), "utf8");

/**
 * @typedef {Object} Open  the active source, opened
 * @property {string} name
 * @property {string} path
 * @property {import("./config.js").Mode} mode
 * @property {boolean} embeddings
 * @property {LiteCtx} ctx
 * @property {LiteCtx | null} kwCtx   embeddings-off handle on the same db, opened on the first search during a meaning pass
 * @property {string[]} repoNames
 * @property {Promise<void> | null} running   the in-flight index pass, if any
 * @property {string | null} error            last index error
 * @property {{ files: number, added: number, updated: number, removed: number, unchanged: number, skipped: { repo: string, error: string }[], ms: number } | null} last
 */

/**
 * Start the UI server.
 * @param {{ port?: number, path?: string, embeddings?: boolean }} [opts]
 *   `path`: add (and activate) this source first; throws a plain Error if it is not usable.
 *   `embeddings`: turn the meaning tier on for the active source (persisted).
 */
export async function createUi(opts = {}) {
  /** @type {Open | null} */
  let cur = null;
  /** @type {string | null} */
  let curError = null;
  let cfg = loadConfig();

  /** @param {import("./config.js").Source} s */
  function openSource(s) {
    curError = null;
    const m = detectMode(s.path);
    if (!m.ok) {
      curError = `${s.name}: ${m.error}`;
      return;
    }
    const ctx = new LiteCtx({ root: s.path, childRepos: m.mode.mode === "repos", embeddings: s.embeddings === true });
    cur = {
      name: s.name,
      path: s.path,
      mode: m.mode,
      embeddings: s.embeddings === true,
      ctx,
      kwCtx: null,
      repoNames: m.mode.mode === "repos" ? childRepos(s.path) : [s.name],
      running: null,
      error: null,
      last: null,
    };
  }

  function closeCurrent() {
    const old = cur;
    cur = null;
    if (!old) return;
    old.kwCtx?.close();
    // never close a store under a running index pass
    if (old.running) void old.running.finally(() => old.ctx.close());
    else old.ctx.close();
  }

  /** One incremental index pass of the active source; concurrent callers share it. @returns {Promise<void>} */
  function reindex() {
    const o = cur;
    if (!o) return Promise.resolve();
    if (o.running) return o.running;
    o.running = (async () => {
      const t = Date.now();
      try {
        const r = await o.ctx.index({ yield: true }); // a cold pass is long; yield so the page + API keep answering
        o.last = { files: r.files, added: r.added, updated: r.updated, removed: r.removed, unchanged: r.unchanged, skipped: r.skipped, ms: Date.now() - t };
        for (const k of r.skipped) console.error(`litectx ui: warning: repo '${k.repo}' skipped (git ls-files failed: ${k.error}); its indexed files were kept`);
        o.error = null;
        if (o.mode.mode === "repos") o.repoNames = childRepos(o.path);
      } catch (e) {
        o.error = e instanceof Error ? e.message : String(e);
      } finally {
        o.running = null;
      }
    })();
    return o.running;
  }

  /** Make `name` the active source (open it, persist it) and start indexing it. @param {string} name */
  function activate(name) {
    const s = cfg.sources.find((x) => x.name === name);
    if (!s) throw new HttpError(404, `no source named '${name}'`);
    const m = detectMode(s.path);
    if (!m.ok) throw new HttpError(400, `${name}: ${m.error}`);
    closeCurrent();
    cfg.active = name;
    saveConfig(cfg);
    openSource(s);
    void reindex();
  }

  /**
   * Add a source and make it active. A path already present is just re-activated.
   * @param {string} path  @param {string} [name]
   * @param {boolean} [makeActive]
   * @param {boolean} [open]  false = only record it (startup opens the active source itself, once)
   * @returns {string} the source name
   */
  function addSource(path, name, makeActive = true, open = true) {
    const m = detectMode(path);
    if (!m.ok) throw new HttpError(400, m.error);
    const same = cfg.sources.find((s) => s.path === path);
    if (same && name === undefined) {
      if (makeActive) record(same.name, open);
      return same.name;
    }
    let nm = name;
    if (nm !== undefined) {
      if (!NAME_RE.test(nm)) throw new HttpError(400, "name must be 1-64 characters");
      if (cfg.sources.some((s) => s.name === nm)) throw new HttpError(409, `a source named '${nm}' already exists`);
    } else {
      const base = basename(path) || "source";
      nm = base;
      for (let i = 2; cfg.sources.some((s) => s.name === nm); i++) nm = `${base}-${i}`;
    }
    cfg.sources.push({ name: nm, path });
    if (makeActive || !cfg.active) record(nm, open);
    else saveConfig(cfg);
    return nm;
  }

  /** @param {string} name @param {boolean} open */
  function record(name, open) {
    if (open) return activate(name);
    cfg.active = name;
    saveConfig(cfg);
  }

  /** @param {string} name @param {boolean} deleteIndex */
  function removeSource(name, deleteIndex) {
    const s = cfg.sources.find((x) => x.name === name);
    if (!s) throw new HttpError(404, `no source named '${name}'`);
    if (cur?.name === name) closeCurrent();
    cfg.sources = cfg.sources.filter((x) => x.name !== name);
    // A one-repo index is the repo's own `.litectx/index.db` — agents use it, so removing the source
    // NEVER deletes it. Only a combined all-repos index may go, and only when the caller ticked the box.
    const m = detectMode(s.path);
    if (deleteIndex && m.ok && m.mode.mode === "repos") {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(join(s.path, ".litectx", `index.db${suffix}`), { force: true });
    }
    cfg.active = cfg.sources.some((x) => x.name === cfg.active) ? cfg.active : (cfg.sources[0]?.name ?? null);
    saveConfig(cfg);
    if (!cur && cfg.active) activate(cfg.active);
  }

  /** @param {string} name @param {boolean} on */
  function setEmbeddings(name, on) {
    const s = cfg.sources.find((x) => x.name === name);
    if (!s) throw new HttpError(404, `no source named '${name}'`);
    if (on) s.embeddings = true;
    else delete s.embeddings;
    saveConfig(cfg);
    if (cur?.name === name) activate(name); // reopen with the new tier setting; the backfill runs as an index pass
  }

  // ---- startup ------------------------------------------------------------------------------------
  if (opts.path) addSource(resolve(opts.path), undefined, true, false);
  const first = cfg.sources.find((x) => x.name === cfg.active);
  if (first) {
    if (opts.embeddings) {
      first.embeddings = true;
      saveConfig(cfg);
    }
    openSource(first); // sets curError instead of throwing when the saved path has gone bad
    void reindex();
  }

  // ---- state for the page -------------------------------------------------------------------------
  function state() {
    return {
      version: VERSION,
      active: cfg.active,
      sources: cfg.sources.map((s) => {
        const m = detectMode(s.path);
        return {
          name: s.name,
          path: s.path,
          embeddings: s.embeddings === true,
          mode: m.ok ? m.mode.mode : null,
          repos: m.ok ? m.mode.repos : 0,
          error: m.ok ? null : m.error,
        };
      }),
      current: cur
        ? {
            name: cur.name,
            mode: cur.mode.mode,
            modeText: describeMode(cur.mode),
            files: cur.ctx.size(),
            indexing: cur.running !== null,
            error: cur.error,
            last: cur.last,
            embeddings: cur.embeddings,
            // the tier was asked for but dropped at runtime (optional peer '@huggingface/transformers' missing): BM25 only
            meaningOff: cur.embeddings && !cur.ctx.embeddings,
            repoNames: cur.repoNames,
          }
        : null,
      error: curError,
    };
  }

  // ---- HTTP ---------------------------------------------------------------------------------------
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/theme.js": ["theme.js", "text/javascript; charset=utf-8"],
    "/state.js": ["state.js", "text/javascript; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
  };
  /** @type {Record<string, string>} */
  const assetBody = {};
  for (const [, [f]] of Object.entries(assets)) assetBody[f] = web(f);

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  async function handle(req, res) {
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    // DNS rebinding: a hostile page can point its own domain at 127.0.0.1, but the browser then sends
    // THAT domain in Host. Only our own loopback names (with our port) are served.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "bad Host header");
    const method = req.method ?? "GET";
    // CSRF: a cross-origin form/fetch POST carries its own Origin. Absent Origin (curl, same-origin
    // navigation) is allowed; present-but-foreign is not.
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, "bad Origin header");
    }
    const u = new URL(req.url ?? "/", `http://${host}`);
    const p = u.pathname;

    if (method === "GET" && p in assets) {
      const [f, type] = assets[/** @type {keyof typeof assets} */ (p)];
      return send(res, 200, type, assetBody[f]);
    }
    if (method === "GET" && p === "/api/search") return apiSearch(res, u.searchParams);
    if (method === "GET" && p === "/view") return view(res, u.searchParams);
    if (p === "/api/sources") {
      if (method === "GET") return json(res, 200, state());
      const body = await readJson(req);
      if (method === "POST") {
        const b = obj(body);
        if (typeof b.active === "string") activate(b.active);
        else if (typeof b.name === "string" && typeof b.embeddings === "boolean") setEmbeddings(b.name, b.embeddings);
        else if (typeof b.path === "string") addSource(b.path, typeof b.name === "string" ? b.name : undefined, b.activate !== false);
        else throw new HttpError(400, "expected {name,path} to add, {active} to switch, or {name,embeddings}");
        return json(res, 200, state());
      }
      if (method === "DELETE") {
        const b = obj(body);
        if (typeof b.name !== "string") throw new HttpError(400, "expected {name, deleteIndex?}");
        removeSource(b.name, b.deleteIndex === true);
        return json(res, 200, state());
      }
    }
    if (p === "/api/reindex" && method === "POST") {
      const b = obj(await readJson(req));
      if (!cur) throw new HttpError(400, "no active source");
      const run = reindex();
      if (b.wait === true) await run;
      return json(res, b.wait === true ? 200 : 202, state());
    }
    if (p === "/api/log" && method === "POST") {
      const b = obj(await readJson(req));
      if (typeof b.q !== "string" || typeof b.path !== "string" || !Number.isInteger(b.rank)) throw new HttpError(400, "expected {q, path, rank}");
      mkdirSync(dirname(logPath()), { recursive: true });
      const line = { ts: new Date().toISOString(), source: cur?.name ?? null, q: b.q.slice(0, 500), path: b.path.slice(0, 1000), rank: b.rank };
      appendFileSync(logPath(), JSON.stringify(line) + "\n");
      return json(res, 200, { ok: true });
    }
    if (p === "/api/open" && method === "POST") {
      const b = obj(await readJson(req));
      if (typeof b.path !== "string" || !Number.isInteger(b.line) || /** @type {number} */ (b.line) < 1) throw new HttpError(400, "expected {path, line} with line a positive integer");
      const { target } = indexedFile(b.path);
      const ed = resolveEditor(cfg.editor);
      if (!ed.ok) throw new HttpError(404, ed.error);
      await launch(ed.path, ["--line", String(b.line), target]);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, "not found");
  }

  /**
   * Resolve a root-relative path to a file of the ACTIVE source's index. Confinement: resolve symlinks on
   * BOTH sides, then require the target to sit inside the root (a lexical `../` check alone is not enough --
   * a tracked symlink can point anywhere). Membership: only indexed files (an untracked `.env` inside the
   * root is not), by one store lookup keyed by the canonical root-relative path -- no git per request.
   * @param {string} rel
   * @returns {{ target: string, rp: string }}
   */
  function indexedFile(rel) {
    if (!cur) throw new HttpError(400, "no active source");
    if (!rel || rel.includes("\0")) throw new HttpError(400, "bad path");
    let rootReal, target;
    try {
      rootReal = realpathSync(cur.path);
      target = realpathSync(resolve(rootReal, rel));
    } catch {
      throw new HttpError(404, "not found");
    }
    const rp = relative(rootReal, target);
    if (rp === "" || rp === ".." || rp.startsWith(`..${sep}`) || isAbsolute(rp)) throw new HttpError(403, "outside the source root");
    const node = cur.ctx.getNode(rp.split(sep).join("/"));
    if (!node || node.source !== "file") throw new HttpError(404, "not an indexed file");
    return { target, rp };
  }

  /** @param {import("node:http").ServerResponse} res @param {URLSearchParams} sp */
  async function apiSearch(res, sp) {
    if (!cur) return json(res, 200, { hits: [], facets: { exts: [], folders: [] }, ms: 0, indexing: false, source: null });
    const list = (/** @type {string} */ k) => (sp.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const t = Date.now();
    const o = cur;
    // While a pass runs with meaning on, the in-flight file embed blocks the event loop and a query embed
    // would wait behind it (~2 s): search by keywords on a second, embeddings-off handle on the same db.
    const kwOnly = o.embeddings && o.running !== null;
    if (kwOnly && !o.kwCtx) o.kwCtx = new LiteCtx({ root: o.path, childRepos: o.mode.mode === "repos", embeddings: false });
    const r = await search(kwOnly && o.kwCtx ? o.kwCtx : o.ctx, o.path, o.mode.mode, o.name, sp.get("q") ?? "", {
      repos: list("repos"),
      kinds: list("kinds"),
      ext: sp.get("ext") || undefined,
      folder: sp.get("folder") || undefined,
      demote: sp.get("demote") !== "0",
      group: sp.get("group") !== "0",
    });
    return json(res, 200, { hits: r.rows, facets: r.facets, ms: Date.now() - t, indexing: o.running !== null, keywordsOnly: kwOnly, source: o.name });
  }

  /** @param {import("node:http").ServerResponse} res @param {URLSearchParams} sp */
  function view(res, sp) {
    const { target } = indexedFile(sp.get("p") ?? "");
    const rel = sp.get("p") ?? "";
    const st = statSync(target);
    if (!st.isFile()) throw new HttpError(404, "not a file");
    if (st.size > MAX_VIEW_BYTES) throw new HttpError(413, "file too large to view");
    const s = Math.max(1, Number.parseInt(sp.get("s") ?? "", 10) || 0);
    const e = Math.max(s, Number.parseInt(sp.get("e") ?? "", 10) || s);
    const lines = readFileSync(target, "utf8").split("\n");
    const body = lines
      .map((l, i) => `<div id="L${i + 1}" class="ln${s && i + 1 >= s && i + 1 <= e ? " on" : ""}"><span class="no">${i + 1}</span>${esc(l)}</div>`)
      .join("");
    return send(
      res,
      200,
      "text/html; charset=utf-8",
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(rel)}</title><link rel="stylesheet" href="/app.css"><script src="/theme.js"></script></head><body class="viewer"><p class="dim"><a href="/">← search</a> · ${esc(rel)}${s ? ` · lines ${s}–${e}` : ""}</p><pre class="file">${body}</pre></body></html>`
    );
  }

  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 4747, "127.0.0.1", () => ok(undefined));
  });
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    /** the active source and mode, for the startup banner */
    describe: () => (cur ? `${cur.name} · mode: ${describeMode(cur.mode)}${cur.embeddings ? " · meaning: on" : ""}` : curError ?? "no sources yet — open the page to add one"),
    /** resolves when the active source's index pass (if any) has finished */
    idle: async () => {
      while (cur?.running) await cur.running;
    },
    state,
    async close() {
      await new Promise((ok) => {
        server.close(() => ok(undefined));
        server.closeAllConnections();
      });
      // Do NOT await the running pass: a cold meaning build runs for many minutes, and Ctrl+C must not wait for it.
      // closeCurrent() defers the store close behind the pass; the CLI exits right after, which is safe (the pass
      // only writes in one synchronous transaction, so an exit between awaits leaves the db at its last commit).
      closeCurrent();
    },
  };
}

/**
 * Start the editor detached, no shell, argv only. Settles once the process has spawned (or failed to).
 * @param {string} bin @param {string[]} args @returns {Promise<void>}
 */
function launch(bin, args) {
  return new Promise((ok, fail) => {
    const c = spawn(bin, args, { detached: true, stdio: "ignore" });
    c.once("error", (e) => fail(new HttpError(500, `could not start the editor: ${e.message}`)));
    c.once("spawn", () => {
      c.unref();
      ok();
    });
  });
}

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} v @returns {Record<string, unknown>} */
function obj(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "expected a JSON object");
  return /** @type {Record<string, unknown>} */ (v);
}

/** @param {import("node:http").IncomingMessage} req @returns {Promise<unknown>} */
function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return ok({});
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", fail);
  });
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {string} type @param {string} body */
function send(res, status, type, body) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
function json(res, status, body) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}
