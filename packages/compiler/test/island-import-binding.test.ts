import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";

const execFileAsync = promisify(execFile);

test.each(["named", "default"])("missing %s island export fails before the target evaluates", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-import-binding-"));
  try {
    const pkg = join(directory, "node_modules", "binding-probe");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({
      name: "binding-probe", type: "module", exports: { types: "./index.d.ts", default: "./index.js" },
    }));
    await writeFile(join(pkg, "index.d.ts"), "export const missing: number; export default function missingDefault(): number;\n");
    await writeFile(join(pkg, "index.js"), 'console.log("dependency evaluated"); export const present = 1;\n');
    const entry = join(directory, "main.mts");
    await writeFile(entry, kind === "named"
      ? 'import { missing } from "binding-probe"; console.log("entry", missing);\n'
      : 'import missing from "binding-probe"; console.log("entry", missing());\n');
    const message = `SyntaxError: The requested module 'binding-probe' does not provide an export named '${kind === "named" ? "missing" : "default"}'`;
    await expect(execFileAsync(nodeOracleExecutable(), [entry])).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining(message),
    });
    const result = await compile(entry, {
      backend: "rust", dynamic: true, optimization: "dev", outDir: directory, outPath: join(directory, "program"),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    await expect(execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    })).rejects.toMatchObject({ code: 1, stdout: "", stderr: `Uncaught ${message}\n` });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
