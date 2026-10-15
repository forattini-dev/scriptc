// @rust-only
// @target bun
// @no-engine
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";
// A real interpreter supplied by the pinned harness, distinct from the compiled executable.
const executable = process.env.SCRIPTC_NODE_ORACLE ?? "node";
const scriptArgs = ["-e"];
const exit = (code: number): string[] => [executable, ...scriptArgs, "process.exit(" + code + ")"];
const child = Bun.spawn(exit(7), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const promise = child.exited;
console.log("promise identity", promise === child.exited, child.pid > 0, child.killed);
console.log("exit", await promise, await child.exited, child.exitCode);
const alias = child;
console.log("alias", await alias.exited);
const root = mkdtempSync(join(tmpdir(), "scriptc-bun-spawn-"));
let order = "";
function command(): string[] { order += "argv;"; return [executable, ...scriptArgs, 'process.exit(process.env.SC_BUN_SPAWN === "present" ? 0 : 9)']; }
function cwd(): string { order += "cwd;"; return root; }
function environment(): Record<string, string | undefined> { order += "env;"; return { ...process.env, SC_BUN_SPAWN: "present", SC_BUN_MISSING: undefined }; }
try {
  writeFileSync(join(root, "marker"), "fixture");
  const proc = globalThis.Bun.spawn(command(), { stdout: "ignore", cwd: cwd(), env: environment(), stderr: "ignore" });
  console.log("environment", await proc.exited, order);
  process.env.SC_BUN_FROM_PARENT = "kept";
  const sharedEnv = { ...process.env, SC_BUN_SPAWN: "before" };
  function mutateCwd(): string { sharedEnv.SC_BUN_SPAWN = "present"; return root; }
  console.log("late env snapshot", await Bun.spawn(command(), { env: sharedEnv, cwd: mutateCwd(), stdout: "ignore", stderr: "ignore" }).exited);
  console.log("spread env keys", await Bun.spawn([executable, ...scriptArgs, 'process.exit(process.env.SC_BUN_FROM_PARENT === "kept" ? 0 : 9)'], { env: sharedEnv, stdout: "ignore", stderr: "ignore" }).exited);
  delete process.env.SC_BUN_FROM_PARENT;
  function invalidEnv(env: Record<string, string>): void {
    try { Bun.spawn(exit(0), { env, stdout: "ignore", stderr: "ignore" }); }
    catch (error) { console.log("env error", (error as Error).name, (error as NodeJS.ErrnoException).code, (error as Error).message); }
  }
  invalidEnv({ SC_BAD: "a\0b" });
  invalidEnv({ "SC_BAD\0KEY": "x" });
  process.env.SC_BUN_PARENT = "parent";
  const check = 'process.exit(require("node:fs").existsSync("marker") && !process.env.SC_BUN_PARENT ? 0 : 9)';
  console.log("cwd and env replace", await Bun.spawn([executable, ...scriptArgs, check], { env: { SC_BUN_SPAWN: "present" }, cwd: root, stdout: "ignore", stderr: "ignore" }).exited);
  delete process.env.SC_BUN_PARENT;
  console.log("PATH and argv0", await Bun.spawn(["node", "-e", 'process.exit(process.argv0 === "node" ? 0 : 9)'], { env: { PATH: process.env.PATH ?? "" }, stdout: "ignore", stderr: "ignore" }).exited);
  try { console.log("empty env lookup", await Bun.spawn(["node", "-e", 'process.exit(process.argv0 === "node" ? 0 : 9)'], { env: {}, stdout: "ignore", stderr: "ignore" }).exited); }
  catch (error) { console.log("empty env lookup", (error as Error).name, (error as NodeJS.ErrnoException).code, (error as Error).message); }
  try { console.log("empty PATH lookup", await Bun.spawn(["node", "-e", 'process.exit(process.argv0 === "node" ? 0 : 9)'], { env: { PATH: "" }, stdout: "ignore", stderr: "ignore" }).exited); }
  catch (error) { console.log("empty PATH lookup", (error as Error).name, (error as NodeJS.ErrnoException).code, (error as Error).message); }
  const savedPath = process.env.PATH ?? "";
  process.env.PATH = join(root, "missing-path");
  try { console.log("startup PATH", await Bun.spawn(["node", "-e", 'process.exit(process.argv0 === "node" ? 0 : 9)'], { stdout: "ignore", stderr: "ignore" }).exited); }
  finally { process.env.PATH = savedPath; }
  try { Bun.spawn(["node", "-e", "process.exit(0)"], { env: { PATH: join(root, "missing-path") }, stdout: "ignore", stderr: "ignore" }); }
  catch (error) { console.log("PATH override", (error as Error).name, (error as NodeJS.ErrnoException).code); }
  const output = 'console.log("inherited")';
  await Bun.spawn([executable, ...scriptArgs, output], { stdout: "inherit", stderr: "inherit" }).exited;
  for (const argv of [[], [""], ["scriptc-missing-subprocess-fixture"], ['scriptc-"missing"'], ["a\0b"], [executable, "a\0b"]]) {
    try { Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }); }
    catch (error) { console.log("error", (error as Error).name, (error as NodeJS.ErrnoException).code, (error as Error).message); }
  }
  if (!windows) {
    const signaled = Bun.spawn([executable, "-e", 'process.kill(process.pid, "SIGTERM")'], { stdout: "ignore", stderr: "ignore" });
    console.log("signal", await signaled.exited, signaled.exitCode, signaled.killed);
  }
} finally { rmSync(root, { recursive: true }); }
export {};
