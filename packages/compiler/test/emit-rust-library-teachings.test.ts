import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary } from "../src/index.js";

test("Rust library traps apply the profile teaching and remediation", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-teaching-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "export function boom(): number { throw new Error('kaput'); }",
      "console.log('teaching ready');",
      "",
    ].join("\n"));
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-trap-teaching",
      entry,
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "rt_",
        init_symbol: "rt_init",
        sink_register_symbol: "rt_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
      },
      exports: [{ export: "boom", symbol: "rt_boom", params: [], returns: "f64" }],
      determinism: {
        teachings: { SC4013: "host-friendly exception\n" },
        remediations: { SC4013: "inspect the command input before retrying" },
      },
    }));
    const result = await compileLibrary({ profilePath, outDir: work });
    expect(
      result.ok,
      result.ok
        ? undefined
        : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;

    const probeSource = join(work, "probe.c");
    writeFileSync(probeSource, [
      "#include <setjmp.h>",
      "#include <stddef.h>",
      "#include <stdint.h>",
      "#include <stdio.h>",
      "static jmp_buf escape;",
      "extern void rt_init(void); extern double rt_boom(void);",
      "extern void rt_set_panic_sink(void (*)(void *, const uint8_t *, size_t, uint64_t), void *);",
      "static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t address) {",
      "  (void)ctx; (void)address; fputs(\"sink:\", stdout);",
      "  for (size_t i = 0; i < len; i++) { if (msg[i] != 1) fputc(msg[i] == 31 ? '|' : msg[i], stdout); }",
      "  fputc('\\n', stdout); longjmp(escape, 1);",
      "}",
      "int main(void) {",
      "  rt_set_panic_sink(sink, NULL); rt_init();",
      "  if (setjmp(escape) == 0) printf(\"returned %.0f\\n\", rt_boom());",
      "  puts(\"survived\"); return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11", probeSource, result.archivePath,
      "-lm", "-ldl", "-lpthread", "-o", probe,
    ]);
    const run = spawnSync(probe, [], { encoding: "utf8" });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe([
      "teaching ready",
      "sink:host-friendly exception",
      "|SC4013|rt_boom|inspect the command input before retrying",
      "survived",
      "",
    ].join("\n"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
