import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { windowsJobInvocation } from "../../../tests/harness/windows-job.js";

test("Rust refuses Node CLI execution through its own executable before spawning descendants", async () => {
  const cache = join(import.meta.dirname, "../../../node_modules/.cache/scriptc-tests");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(tmpdir(), "scriptc-self-cli-"));
  const entry = join(directory, "main.ts");
  writeFileSync(entry, 'import { spawn } from "node:child_process";\ntry { spawn(process.execPath, ["-e", "process.exit(0)"], {stdio:"ignore"}); } catch(error) { console.log((error as NodeJS.ErrnoException).code); }\n');
  const result = await compile(entry, { backend: "rust", optimization: "dev", allowEngine: false, outDir: directory, outPath: join(directory, `program${process.platform === "win32" ? ".exe" : ""}`) });
  if (!result.ok) throw new Error(result.diagnostics.map(diagnostic => `${diagnostic.code} ${diagnostic.message}`).join("\n"));
  expect(result.execution.engine).toBe("none");
  const invocation = windowsJobInvocation(result.binaryPath, [], cache);
  const output = await promisify(execFile)(invocation.command, invocation.args, { encoding: "utf8", timeout: 10_000 });
  expect(output.stdout).toBe("SC3001\n");
  expect(output.stderr).toBe("");
  const receipt = invocation.verifyExit(0);
  if (receipt) expect(receipt.totalProcesses).toBe(1);
});
