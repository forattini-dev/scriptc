import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const backends = sanitize ? ["c", "llvm"] as const : ["rust", "c", "llvm"] as const;

test.each(backends)("%s enforces the catchable WebAssembly policy in compiled modules", async (backend) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-wasm-policy-"));
  try {
    const result = await compile(resolve("tests/fixtures/npm/divergent/wasm.ts"), {
      outDir: directory, outPath: join(directory, "program"),
      backend, optimization: "dev", dynamic: true, sanitize,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const native = await execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    });
    // Match the existing npm harness: remove only ASan's documented
    // fiber advisory, retaining every program byte and sanitizer error.
    const stderr = sanitize ? native.stderr.replace(
      /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm, "",
    ) : native.stderr;
    expect(stderr).toBe("");
    expect(native.stdout).toBe(
      "WebAssembly.instantiate is not supported in scriptc binaries (the embedded engine has no wasm runtime)\n" +
      "true|RuntimeError|Aborted(Error: boom)\nfalse\n" +
      "compile:true|instantiate:true|compileStreaming:true|instantiateStreaming:true|" +
      "Module:true|Instance:true|Memory:true|Table:true|Global:true|" +
      "RuntimeError:true|CompileError:true|LinkError:true|valid:false\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
