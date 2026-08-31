import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary } from "../src/index.js";

test("runtime-localized Rust libraries keep independent state in one host", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-multi-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "let total = 0;",
      "export function add(value: number): number { total += value; return total; }",
      "",
    ].join("\n"));

    const build = async (name: "a" | "b"): Promise<string> => {
      const outDir = join(work, name);
      const prefix = `m${name}_`;
      const profilePath = join(work, `profile-${name}.json`);
      writeFileSync(profilePath, JSON.stringify({
        profile_format: 1,
        name: `rust-multi-${name}`,
        entry,
        emission: "rust",
        optimization: "dev",
        abi: {
          prefix,
          init_symbol: `${prefix}init`,
          sink_register_symbol: `${prefix}set_panic_sink`,
          collect_symbol: null,
          result_reset_symbol: null,
          localize_runtime: true,
        },
        exports: [{
          export: "add",
          symbol: `${prefix}add`,
          params: ["f64"],
          returns: "f64",
        }],
      }));
      const result = await compileLibrary({ profilePath, outDir });
      expect(
        result.ok,
        result.ok
          ? undefined
          : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
      ).toBe(true);
      if (!result.ok) throw new Error("Rust library build refused");
      return result.archivePath;
    };
    const archiveA = await build("a");
    const archiveB = await build("b");

    const probeSource = join(work, "probe.c");
    writeFileSync(probeSource, [
      "#include <stdio.h>",
      "extern void ma_init(void); extern double ma_add(double);",
      "extern void mb_init(void); extern double mb_add(double);",
      "int main(void) {",
      "  ma_init(); mb_init();",
      "  double a1 = ma_add(1); double a2 = ma_add(1);",
      "  double b1 = mb_add(10); double b2 = mb_add(10);",
      "  printf(\"a %.0f %.0f\\n\", a1, a2);",
      "  printf(\"b %.0f %.0f\\n\", b1, b2);",
      "  printf(\"a-after %.0f\\n\", ma_add(1));",
      "  printf(\"b-after %.0f\\n\", mb_add(10));",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      archiveA,
      archiveB,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe([
      "a 1 2",
      "b 10 20",
      "a-after 3",
      "b-after 30",
      "",
    ].join("\n"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("release runtime-localized Rust archives preserve only profile-declared symbols", async (context) => {
  if (spawnSync("nm", ["--version"], { encoding: "utf8" }).status !== 0) {
    context.skip("nm is required to inspect the archive link surface");
  }
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-symbols-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, "export function add(value: number): number { return value + 1; }\n");
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-localized-symbols",
      entry,
      emission: "rust",
      optimization: "release",
      abi: {
        prefix: "ms_",
        init_symbol: "ms_init",
        sink_register_symbol: "ms_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
        localize_runtime: true,
      },
      exports: [{
        export: "add",
        symbol: "ms_add",
        params: ["f64"],
        returns: "f64",
      }],
    }));
    const result = await compileLibrary({ profilePath, outDir: work });
    expect(
      result.ok,
      result.ok
        ? undefined
        : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;

    const defined = new Set(
      execFileSync("nm", ["-g", "--defined-only", result.archivePath], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
        .split("\n")
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((symbol): symbol is string =>
          symbol !== undefined && symbol !== "" && !symbol.endsWith(":"))
        .map((symbol) => symbol.replace(/^_/, "")),
    );
    expect([...defined].sort()).toEqual([
      "ms_add",
      "ms_init",
      "ms_set_panic_sink",
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 240_000);
