import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

// The trap observes scriptc's C/LLVM discovery. Rust still uses its ordinary
// rustc linker to produce and execute a real native binary.
test.skipIf(process.platform === "win32").for([
  { selection: "default", route: "runtime-pack" },
  { selection: "rust", route: "runtime-pack" },
  { selection: "default", route: "driver" },
  { selection: "rust", route: "driver" },
] as const)("$selection Rust build ignores unused $route tool discovery", async ({ selection, route }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-toolchain-isolation-"));
  try {
    const marker = join(dir, "c-tools.log");
    const trap = join(dir, "clang");
    // POSIX shell quoting also handles a temp directory containing apostrophes.
    const quotedMarker = "'" + marker.replaceAll("'", "'\\''") + "'";
    await writeFile(trap, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quotedMarker}\nexit 91\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env["PATH"] ?? ""}`);
    vi.stubEnv("SCRIPTC_LINKER", trap);
    vi.stubEnv("SCRIPTC_CC", route === "driver" ? "clang" : "");
    vi.stubEnv("SCRIPTC_RUNTIME_PACK", route === "driver" ? "0" : "1");
    const entry = join(dir, "main.ts");
    await writeFile(entry, 'const values: number[] = [1, 2, 3]; console.log(values.map(value => value * 2).join(","));\n');
    const result = await compile(entry, {
      ...(selection === "rust" ? { backend: "rust" as const } : {}),
      optimization: "dev",
      allowEngine: false,
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("rust");
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const node = await execFileAsync(process.execPath, [entry]);
    const native = await execFileAsync(result.binaryPath);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
    expect(native.stdout).toBe("2,4,6\n");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
