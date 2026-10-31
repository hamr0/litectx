// Menu pick 4 must stay stoppable: while a pass runs, Ctrl+C has to reach the process. An open readline holds the
// terminal in raw mode, where Ctrl+C is only a keypress for readline, so the menu closes it before indexing.
// Real pty, temp HOME, a stand-in index action that runs "forever".

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MENU = fileURLToPath(new URL("../src/cli/menu.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "litectx-menu-ctrlc-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;

test("menu pick 4: Ctrl+C during the index pass ends the process by SIGINT within 3s", { skip: !hasPython }, async () => {
  const script = join(tmp, "run.mjs");
  writeFileSync(
    script,
    `import { menu } from ${JSON.stringify(MENU)};
const code = await menu({ index: async () => { console.log("INDEXING"); await new Promise((r) => setTimeout(r, 60000)); } });
process.exit(code);
`
  );
  const py = `import pty,os,sys,select,re,time,json
node=${JSON.stringify(process.execPath)}
pid,fd=pty.fork()
if pid==0:
    os.execve(node,[node,${JSON.stringify(script)}],os.environ)
out=b""; typed=["4","/some/folder"]; seen=0; t_c=None; res=None
t0=time.time()
while time.time()-t0<40:
    r,_,_=select.select([fd],[],[],0.1)
    if r:
        try: d=os.read(fd,65536)
        except OSError: break
        if not d: break
        out+=d
        plain=re.sub(rb"\\x1b\\[[0-9;?]*[a-zA-Z]",b"",out)
        n=len(re.findall(rb"(> |folder to index: )",plain))
        if typed and n>seen:
            seen+=1; os.write(fd,typed.pop(0).encode()+b"\\r")
        if t_c is None and b"INDEXING" in plain:
            time.sleep(0.5); os.write(fd,b"\\x03"); t_c=time.time()
    if t_c:
        w,st=os.waitpid(pid,os.WNOHANG)
        if w: res=(os.waitstatus_to_exitcode(st),time.time()-t_c); break
        if time.time()-t_c>3: break
while res is None and t_c and time.time()-t_c<3:
    w,st=os.waitpid(pid,os.WNOHANG)
    if w: res=(os.waitstatus_to_exitcode(st),time.time()-t_c)
    else: time.sleep(0.05)
if res is None:
    try: os.kill(pid,9)
    except OSError: pass
    os.waitpid(pid,0)
print(json.dumps({"res":res}))
`;
  const env = { ...process.env, HOME: join(tmp, "home"), LITECTX_UI_CONFIG: join(tmp, "ui.json"), LITECTX_DEFAULT_PORT: String(20000 + Math.floor(Math.random() * 30000)) };
  const out = await new Promise((ok) => {
    const c = spawn("python3", ["-I", "-c", py], { env, stdio: ["ignore", "pipe", "ignore"] });
    let o = "";
    c.stdout.on("data", (d) => (o += d));
    c.on("close", () => ok(o));
  });
  const res = JSON.parse(String(out).trim().split("\n").pop() ?? "{}").res;
  assert.ok(res, "the process was still running 3s after Ctrl+C");
  assert.equal(res[0], -2, "ended by SIGINT");
});
