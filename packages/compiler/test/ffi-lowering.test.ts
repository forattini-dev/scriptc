import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("Rust retains manifest-bound FFI calls in global and local initializers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-ffi-initializers-"));
  dirs.push(dir);
  const nativeSource = join(dir, "native.c");
  const nativeObject = join(dir, "native.o");
  const nativeArchive = join(dir, "libnative.a");
  const profilePath = join(dir, "profile.json");
  const entry = join(dir, "main.ts");
  const outPath = join(dir, "program");

  await writeFile(nativeSource, [
    "double sf_number(double value) { return value * 10.0; }",
    "unsigned char sf_boolean(unsigned char value) { return value ? 0 : 1; }",
    "",
  ].join("\n"));
  await execFileAsync("clang", ["-std=c11", "-O2", "-c", nativeSource, "-o", nativeObject]);
  await execFileAsync("ar", ["rcs", nativeArchive, nativeObject]);

  await writeFile(
    entry,
    [
      "declare function nativeNumber(value: number): number;",
      "declare function nativeBoolean(value: boolean): boolean;",
      "const moduleConst = nativeNumber(1);",
      "let moduleLet = nativeBoolean(false);",
      "var moduleVar = nativeNumber(2);",
      "console.log(moduleConst, moduleLet, moduleVar);",
      "function localBindings() {",
      "  const localConst = nativeNumber(3);",
      "  let localLet = nativeBoolean(true);",
      "  var localVar = nativeNumber(4);",
      "  console.log(localConst, localLet, localVar);",
      "}",
      "localBindings();",
      "",
    ].join("\n"),
  );
  await writeFile(
    profilePath,
    JSON.stringify({
      ffi_format: 1,
      functions: [
        { name: "nativeNumber", symbol: "sf_number", params: ["f64"], returns: "f64" },
        { name: "nativeBoolean", symbol: "sf_boolean", params: ["bool"], returns: "bool" },
      ],
      libraries: [nativeArchive],
    }),
  );

  const result = await compile(entry, {
    outDir: dir,
    outPath,
    backend: "rust",
    optimization: "dev",
    ffiProfilePath: profilePath,
  });
  expect(
    result.ok,
    result.ok ? entry : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const run = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  expect(run.stdout).toBe("10 true 20\n30 false 40\n");
  expect(run.stderr).toBe("");
});
