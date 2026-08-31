import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary } from "../src/index.js";

interface TrapProbeOptions {
  readonly source: string;
  readonly teachingCode: string;
  readonly teaching: string;
  readonly remediation: string;
  readonly probeSetup?: readonly string[];
}

async function runTrapProbe(options: TrapProbeOptions): Promise<ReturnType<typeof spawnSync>> {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-teaching-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, options.source);
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
        teachings: { [options.teachingCode]: options.teaching },
        remediations: { [options.teachingCode]: options.remediation },
      },
    }));
    const result = await compileLibrary({ profilePath, outDir: work });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    }

    const probeSource = join(work, "probe.c");
    writeFileSync(probeSource, [
      "#define _GNU_SOURCE",
      "#include <setjmp.h>",
      "#include <stddef.h>",
      "#include <stdint.h>",
      "#include <stdio.h>",
      "#include <stdlib.h>",
      "#include <unistd.h>",
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
      ...(options.probeSetup ?? []),
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
    return spawnSync(probe, [], { encoding: "utf8" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("Rust library traps apply the profile teaching and remediation", async () => {
  const run = await runTrapProbe({
    source: [
      "export function boom(): number { throw new Error('kaput'); }",
      "console.log('teaching ready');",
      "",
    ].join("\n"),
    teachingCode: "SC4013",
    teaching: "host-friendly exception\n",
    remediation: "inspect the command input before retrying",
  });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe([
    "teaching ready",
    "sink:host-friendly exception",
    "|SC4013|rt_boom|inspect the command input before retrying",
    "survived",
    "",
  ].join("\n"));
}, 120_000);

test("Rust library range traps select the SC4014 teaching", async () => {
  const run = await runTrapProbe({
    source: [
      "export function boom(): number { return 'x'.repeat(-1).length; }",
      "console.log('range ready');",
      "",
    ].join("\n"),
    teachingCode: "SC4014",
    teaching: "host-friendly range trap\n",
    remediation: "check the requested range before retrying",
  });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe([
    "range ready",
    "sink:host-friendly range trap",
    "|SC4014|rt_boom|check the requested range before retrying",
    "survived",
    "",
  ].join("\n"));
}, 120_000);

test("Rust library typed record misses select the SC4015 teaching", async () => {
  const run = await runTrapProbe({
    source: [
      "const values: Record<string, number> = { present: 1 };",
      "export function boom(): number { const key = 'missing'; return values[key]; }",
      "console.log('type ready');",
      "",
    ].join("\n"),
    teachingCode: "SC4015",
    teaching: "host-friendly type trap\n",
    remediation: "check the requested key before retrying",
  });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe([
    "type ready",
    "sink:host-friendly type trap",
    "|SC4015|rt_boom|check the requested key before retrying",
    "survived",
    "",
  ].join("\n"));
}, 120_000);

test("Rust library regular expression traps select the SC4016 teaching", async () => {
  const run = await runTrapProbe({
    source: [
      "function pattern(): string { return '['; }",
      "export function boom(): number { return new RegExp(pattern()).test('x') ? 1 : 0; }",
      "console.log('syntax ready');",
      "",
    ].join("\n"),
    teachingCode: "SC4016",
    teaching: "host-friendly syntax trap\n",
    remediation: "validate the regular expression before retrying",
  });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe([
    "syntax ready",
    "sink:host-friendly syntax trap",
    "|SC4016|rt_boom|validate the regular expression before retrying",
    "survived",
    "",
  ].join("\n"));
}, 120_000);

test("Rust library invalid regular expression flags select the SC4016 teaching", async () => {
  const run = await runTrapProbe({
    source: [
      "function flags(): string { return 'x'; }",
      "export function boom(): number { return new RegExp('a', flags()).test('a') ? 1 : 0; }",
      "console.log('flags ready');",
      "",
    ].join("\n"),
    teachingCode: "SC4016",
    teaching: "host-friendly flags trap\n",
    remediation: "validate the regular expression flags before retrying",
  });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stdout).toBe([
    "flags ready",
    "sink:host-friendly flags trap",
    "|SC4016|rt_boom|validate the regular expression flags before retrying",
    "survived",
    "",
  ].join("\n"));
}, 120_000);

test("Rust library environment traps select the residual SC4019 teaching", async () => {
  const run = await runTrapProbe({
    source: [
      "export function boom(): number { return process.cwd().length; }",
      "console.log('cwd ready');",
      "",
    ].join("\n"),
    teachingCode: "SC4019",
    teaching: "host-friendly environment trap\n",
    remediation: "restore a valid working directory before retrying",
    probeSetup: [
      "  char cwd_template[] = \"/tmp/scriptc-rust-cwd-XXXXXX\";",
      "  char *cwd = mkdtemp(cwd_template);",
      "  if (cwd == NULL || chdir(cwd) != 0 || rmdir(cwd) != 0) return 2;",
    ],
  });
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toBe([
    "cwd ready",
    "sink:host-friendly environment trap",
    "|SC4019|rt_boom|restore a valid working directory before retrying",
    "survived",
    "",
  ].join("\n"));
}, 120_000);
