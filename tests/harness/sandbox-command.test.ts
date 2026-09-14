import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { sandboxCommand } from "../../scripts/sandbox-command.mjs";

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
