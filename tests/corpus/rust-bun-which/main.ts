// @rust-only
// @target bun
// @no-engine
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "scriptc-which-"));
const first = join(root, "first"), second = join(root, "second");
mkdirSync(first); mkdirSync(second);
const windows = process.platform === "win32";
const suffix = windows ? ".cmd" : "";
const command = "scriptc-which-fixture";
const executable = join(first, command + suffix);
writeFileSync(executable, "fixture, never executed\n");
writeFileSync(join(second, command + suffix), "second\n");
chmodSync(executable, 0o755);
chmodSync(join(second, command + suffix), 0o755);
const separator = windows ? ";" : ":";
try {
  console.log("found", Bun.which(command, { PATH: first }) === executable);
  console.log("globalThis", globalThis.Bun.which(command, { PATH: first }) === executable);
  console.log("ordered", Bun.which(command, { PATH: first + separator + second }) === executable);
  console.log("skip missing", Bun.which(command, { PATH: join(root, "missing") + separator + second }) === join(second, command + suffix));
  console.log("empty segments", Bun.which(command, { PATH: separator + first + separator }) === executable);
  console.log("missing", Bun.which("scriptc-no-such-command", { PATH: first }) === null);
  console.log("empty path", Bun.which(command, { PATH: "" }) === null);
  console.log("empty command", Bun.which("", { PATH: first }) === null);
  console.log("absolute", Bun.which(executable, { PATH: "" }) === executable);
  console.log("relative", Bun.which("./" + command + suffix, { cwd: first, PATH: "" }) === executable);
  const savedCwd = process.cwd();
  try {
    process.chdir(first);
    console.log("live cwd", Bun.which("./" + command + suffix, { PATH: "" }) === executable);
    console.log("relative PATH spelling", Bun.which(command, { PATH: "." }) === "." + (windows ? "\\" : "/") + command + suffix);
  } finally { process.chdir(savedCwd); }
  const unicode = "ação-开始" + suffix;
  writeFileSync(join(first, unicode), "not executed"); chmodSync(join(first, unicode), 0o755);
  console.log("unicode", Bun.which(unicode, { PATH: first }) === join(first, unicode));
  console.log("slash avoids PATH", Bun.which("./" + command + suffix, { cwd: second, PATH: first }) === join(second, command + suffix));
  console.log("no cwd lookup", Bun.which(command, { cwd: first, PATH: "" }) === null);
  mkdirSync(join(first, "directory" + suffix));
  console.log("directory", Bun.which("directory" + suffix, { PATH: first }) === null);
  const options: { PATH?: string; cwd?: string } = { PATH: first };
  console.log("stored options", Bun.which(command, options) === executable);
  const missingOptions: { PATH?: string; cwd?: string } | undefined = undefined;
  console.log("undefined options", Bun.which("scriptc-no-such-command", missingOptions) === null);
  console.log("explicit undefined", Bun.which("scriptc-no-such-command", undefined) === null);
  console.log("default PATH", Bun.which(windows ? "cmd" : "sh") !== null);
  const locate = Bun.which;
  console.log("function value", locate(command, { PATH: first }) === executable);
  console.log("function omitted options", locate("scriptc-no-such-command") === null);
  const choose = (override?: (name: string) => string | null) => override ?? Bun.which;
  console.log("nullish function", choose()("scriptc-no-such-command") === null);
  console.log("user function", choose(name => name)("custom") === "custom");
  let calls = "";
  function source(): string { calls += "command,"; return command; }
  function opts(): { PATH: string } { calls += "options,"; return { PATH: first }; }
  console.log("evaluate once", Bun.which(source(), opts()) === executable, calls);
  const mutable = { PATH: "" };
  function mutate(): { PATH: string } { mutable.PATH = first; return mutable; }
  console.log("option mutation", Bun.which(command, mutate()) === executable);
  const savedPath = process.env.PATH ?? "";
  const hadPath = process.env.PATH !== undefined;
  try {
    process.env.PATH = first;
    console.log("startup environment", Bun.which(command) === null);
    console.log("undefined field", Bun.which(command, { PATH: undefined }) === null);
    console.log("indirect environment", locate(command) === null);
    process.env.PATH = second;
    console.log("startup environment retained", Bun.which(command) === null);
  } finally {
    if (!hadPath) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
  if (windows) {
    writeFileSync(join(first, command + ".exe"), "never executed");
    console.log("extension order", Bun.which(command, { PATH: first }) === join(first, command + ".exe"));
    console.log("explicit extension", Bun.which(command + ".cmd", { PATH: first }) === executable);
    writeFileSync(join(first, "extensionless"), "not a Windows executable");
    console.log("no extension", Bun.which("extensionless", { PATH: first }) === null);
  } else {
    const blocked = join(first, "not-executable");
    writeFileSync(blocked, "cannot execute"); chmodSync(blocked, 0o644);
    console.log("permission", Bun.which("not-executable", { PATH: first }) === null);
    console.log("absolute spelling", Bun.which(first + "/../first/" + command, { PATH: "" }) === first + "/../first/" + command);
  }
  try { Bun.which("a".repeat(100000)); } catch (error) { console.log("long command", error instanceof Error, (error as Error).message); }
  const custom = { which: (name: string): string => "custom:" + name };
  function shadow(Bun: typeof custom): void { console.log("shadow", Bun.which("test")); }
  shadow(custom);
} finally { rmSync(root, { recursive: true, force: true }); }
