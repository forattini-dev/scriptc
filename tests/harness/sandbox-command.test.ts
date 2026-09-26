import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { REMOTE_COMMAND_PENDING, sandboxCommand, sandboxStatusCommand } from "../../scripts/sandbox-command.mjs";

const roots: string[] = [];
const statuses: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(statuses.splice(0).map((path) => rm(path, { force: true })));
});

test("short commands stay inline and retain the remote exit contract", async () => {
  const marker = `__SCRIPTC_COMMAND_TEST_${process.pid}_SHORT__`;
  const prepared = sandboxCommand("sh", ["-c", "exit 7"], marker);
  statuses.push(prepared.statusPath);

  expect(prepared.file).toBe(false);
  const output = execFileSync(prepared.argv[0], prepared.argv.slice(1), { encoding: "utf8" });
  expect(output).toBe(`\n${marker}7\n`);
  expect(await readFile(prepared.statusPath, "utf8")).toBe("7\n");
});

test("uploaded scripts preserve long and shell-sensitive argument bytes", async () => {
  const root = await mkdtemp("/tmp/scriptc-sandbox-command-test-");
  roots.push(root);
  const sentinel = join(root, "unexpected");
  const args = [
    "x".repeat(2048),
    "quote' and spaces",
    `$(touch ${sentinel})`,
    "backtick` dollar$ slash\\ newline\nend",
    "é".repeat(512),
  ];
  const marker = `__SCRIPTC_COMMAND_TEST_${process.pid}_LONG__`;
  const prepared = sandboxCommand("printf", ["<%s>\n", ...args], marker);
  statuses.push(prepared.statusPath);
  expect(prepared.file).toBe(true);
  expect(prepared.argv).toEqual(["sh", prepared.scriptPath]);
  expect(prepared.argv.every((arg) => arg.length < 128)).toBe(true);

  const localScript = join(root, "command.sh");
  await writeFile(localScript, prepared.script);
  const output = execFileSync("sh", [localScript], { encoding: "utf8" });
  expect(output).toBe(args.map((arg) => `<${arg}>\n`).join("") + `\n${marker}0\n`);
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(prepared.statusPath, "utf8")).toBe("0\n");
});

test("status recovery waits for a disconnected command's actual exit", async () => {
  const root = await mkdtemp("/tmp/scriptc-sandbox-status-test-");
  roots.push(root);
  const path = join(root, "command.status");
  const marker = "__STATUS_TEST__";
  const pending = promisify(execFile)("sh", ["-c", sandboxStatusCommand(path, marker, 2)]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(path, "7\n");
  expect((await pending).stdout).toBe(`\n${marker}7\n`);

  await writeFile(path, "0\n");
  expect(execFileSync("sh", ["-c", sandboxStatusCommand(path, marker, 0)], { encoding: "utf8" })).toBe(`\n${marker}0\n`);
  await writeFile(path, "125\n");
  expect(execFileSync("sh", ["-c", sandboxStatusCommand(path, marker, 0)], { encoding: "utf8" })).toBe(`\n${marker}125\n`);
});

test("an absent or incomplete status remains pending rather than passing", async () => {
  const root = await mkdtemp("/tmp/scriptc-sandbox-status-test-");
  roots.push(root);
  const path = join(root, "command.status");
  const marker = "__STATUS_TEST__";
  const probe = () => execFileSync("sh", ["-c", sandboxStatusCommand(path, marker, 0)], { encoding: "utf8" });
  expect(probe()).toBe(`\n${marker}${REMOTE_COMMAND_PENDING}\n`);
  await writeFile(path, "");
  expect(probe()).toBe(`\n${marker}${REMOTE_COMMAND_PENDING}\n`);
});
