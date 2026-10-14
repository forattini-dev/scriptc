import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);
const cli = join(import.meta.dirname, "../src/main.ts");
const args = ["--import", "tsx", cli];

test("JSON diagnostics describe source success, source refusal and argument errors without terminal output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-json-diagnostics-"));
  try {
    const entry = join(directory, "main.ts");
    const artifact = join(directory, "main.rs");
    await writeFile(entry, 'console.log("hello");');
    const successful = await run(process.execPath, [...args, "build", entry, "--emit=rust", "--no-engine", "--print=diagnostics", "-o", artifact]);
    expect(JSON.parse(successful.stdout)).toMatchObject({ schema: "scriptc-diagnostics", schemaVersion: 1, success: true, command: "build", backend: "rust", artifact, diagnostics: [] });
    expect(await readFile(artifact, "utf8")).toContain("forbid(unsafe_code)");
    await writeFile(entry, 'const value: number = "bad"; console.log(value);');
    let refusal: { stdout: string; code: number } | undefined;
    try { await run(process.execPath, [...args, "coverage", entry, "--print=diagnostics", "--fail-on=blockers"]); }
    catch (error) { refusal = error as typeof refusal; }
    expect(refusal?.code).toBe(1);
    expect(JSON.parse(refusal!.stdout)).toMatchObject({ success: false, phase: "preflight", diagnostics: [{ code: "SC0001", scope: "preflight" }] });
    let invalid: { stdout: string; code: number } | undefined;
    try { await run(process.execPath, [...args, "build", entry, "--print=diagnostics", "--fail-on=blockers"]); }
    catch (error) { invalid = error as typeof invalid; }
    expect(invalid?.code).toBe(1);
    expect(JSON.parse(invalid!.stdout)).toMatchObject({ success: false, phase: "arguments", error: "--fail-on is a coverage option" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
