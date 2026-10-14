import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parent = process.cwd();
const directory = mkdtempSync(join(tmpdir(), "scriptc-spawn-cwd-"));
const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/pwd";
const args = process.platform === "win32" ? ["/d", "/c", "cd"] : [];
let order = "";
function mark(label: string, value: string): string { order += label + ","; return value; }
function encoding(): "utf8" { order += "encoding,"; return "utf8"; }
function timeout(): number { order += "timeout,"; return 10000; }
function stdio(): "pipe" { order += "stdio,"; return "pipe"; }
function signal(): "SIGTERM" { order += "signal,"; return "SIGTERM"; }
try {
  const result = spawnSync(mark("command", command), args, {
    cwd: mark("cwd", directory), encoding: encoding(), timeout: timeout(), stdio: stdio(), killSignal: signal(),
  });
  console.log(result.status, result.stdout.trim() === directory, process.cwd() === parent);
  console.log(order);
  const explicitEnv = spawnSync(command, args, { cwd: directory, encoding: "utf8", env: { SCRIPTC_CWD_MARKER: "kept" } });
  console.log(explicitEnv.status, explicitEnv.stdout.trim() === directory, process.cwd() === parent);
  const noCwd = spawnSync(command, args, { cwd: undefined, encoding: "utf8" });
  console.log(noCwd.status, noCwd.stdout.trim() === parent);
  const missing = spawnSync(command, args, { cwd: join(directory, "absent"), encoding: "utf8" });
  console.log(missing.status === null, missing.signal === null, typeof missing.error);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
