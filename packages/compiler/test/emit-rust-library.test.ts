import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary } from "../src/index.js";

const expected = `scalars ready
add: 0.30000000000000004
max-safe exact: 1
nan passthrough: 1
neg zero sign: 1
is_nan(NaN): 1
is_nan(1): 0
invert(0): 1
invert(7): 0
plumb: 40000254995
`;

test("Rust library archives expose scalar exports to a native host", async () => {
  const fixture = resolve("tests/library-mode/scalars");
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-"));
  try {
    const profile = JSON.parse(
      readFileSync(join(fixture, "profile.json"), "utf8"),
    ) as Record<string, unknown>;
    profile["entry"] = join(fixture, "lib.ts");
    profile["emission"] = "rust";
    profile["optimization"] = "dev";
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = await compileLibrary({ profilePath, outDir: work });
    expect(
      result.ok,
      result.ok
        ? undefined
        : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("rust");

    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      join(fixture, "probe.c"),
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(expected);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library archives decode host string spans", async () => {
  const fixture = resolve("tests/library-mode/buffers");
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-string-"));
  try {
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-string-input",
      entry: join(fixture, "lib.ts"),
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "kb_",
        init_symbol: "kb_init",
        sink_register_symbol: "kb_set_panic_sink",
        collect_symbol: "kb_collect",
        result_reset_symbol: null,
      },
      exports: [{
        export: "strlen",
        symbol: "kb_strlen",
        params: ["string"],
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

    const probeSource = join(work, "probe.c");
    writeFileSync(probeSource, [
      "#include <stddef.h>",
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern void kb_init(void);",
      "extern double kb_strlen(const uint8_t *p, size_t len);",
      "int main(void) {",
      "  kb_init();",
      "  printf(\"lengths: %.0f %.0f\\n\", kb_strlen(NULL, 0),",
      "         kb_strlen((const uint8_t *)\"caf\\xC3\\xA9\", 5));",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(
      "buffers ready\nlengths: 0 4\n",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library archives retain string results for the native host", async () => {
  const fixture = resolve("tests/library-mode/buffers");
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-string-out-"));
  try {
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-string-output",
      entry: join(fixture, "lib.ts"),
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "kb_",
        init_symbol: "kb_init",
        sink_register_symbol: "kb_set_panic_sink",
        collect_symbol: "kb_collect",
        result_reset_symbol: null,
      },
      exports: [{
        export: "shout",
        symbol: "kb_shout",
        params: ["string"],
        returns: "string",
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

    const probeSource = join(work, "probe.c");
    writeFileSync(probeSource, [
      "#include <stddef.h>",
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern void kb_init(void);",
      "extern void kb_shout(const uint8_t *p, size_t len,",
      "                     const uint8_t **out, size_t *out_len);",
      "int main(void) {",
      "  kb_init();",
      "  const uint8_t *value; size_t len;",
      "  kb_shout((const uint8_t *)\"abc\", 3, &value, &len);",
      "  printf(\"shout: %.*s len %zu nul %d\\n\",",
      "         (int)len, value, len, value[len] == 0);",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(
      "buffers ready\nshout: ABC! len 4 nul 1\n",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library archives round-trip the official buffer ABI fixture", async () => {
  const fixture = resolve("tests/library-mode/buffers");
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-buffers-"));
  try {
    const profile = JSON.parse(
      readFileSync(join(fixture, "profile.json"), "utf8"),
    ) as Record<string, unknown>;
    profile["entry"] = join(fixture, "lib.ts");
    profile["emission"] = "rust";
    profile["optimization"] = "dev";
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = await compileLibrary({ profilePath, outDir: work });
    expect(
      result.ok,
      result.ok
        ? undefined
        : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;

    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      join(fixture, "probe.c"),
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe([
      "buffers ready",
      "shout: ABC! (len 4, nul 1)",
      "both live: ABC! / a-b-c",
      "strlen empty (NULL, 0): 0",
      "strlen utf8: 4",
      "wrap: len 4 bytes 60 1 2 62",
      "wrap empty: len 2 bytes 60 62",
      "",
    ].join("\n"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library init starts byte-identical sessions", async () => {
  const fixture = resolve("tests/library-mode/reinit");
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-reinit-"));
  try {
    const profile = JSON.parse(
      readFileSync(join(fixture, "profile.json"), "utf8"),
    ) as Record<string, unknown>;
    profile["entry"] = join(fixture, "lib.ts");
    profile["emission"] = "rust";
    profile["optimization"] = "dev";
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = await compileLibrary({ profilePath, outDir: work });
    expect(
      result.ok,
      result.ok
        ? undefined
        : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;

    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      join(fixture, "probe.c"),
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    const session = [
      "session start counter=0",
      "bump: 1 2",
      "note: 1 2",
      "recall: a,b",
      "",
    ].join("\n");
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(session.repeat(3));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library exceptions escape through the registered panic sink", async () => {
  const fixture = resolve("tests/library-mode/traps");
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-trap-"));
  try {
    const profile = JSON.parse(
      readFileSync(join(fixture, "profile.json"), "utf8"),
    ) as Record<string, unknown>;
    profile["entry"] = join(fixture, "lib.ts");
    profile["emission"] = "rust";
    profile["optimization"] = "dev";
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = await compileLibrary({ profilePath, outDir: work });
    expect(
      result.ok,
      result.ok
        ? undefined
        : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;

    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      join(fixture, "probe.c"),
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    const run = spawnSync(probe, ["throw"], { encoding: "utf8" });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe([
      "traps ready",
      "sink[1]:",
      "text=[Uncaught Error: kaput",
      "]",
      "code=[SC4013]",
      "symbol=[kp_fail]",
      "fields=3 text_printable=1",
      "addr: nonzero",
      "survived, sink_calls=1",
      "",
    ].join("\n"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library callbacks synchronously round-trip scalars through the host", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-callback-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "declare function hostAdd(value: number): number;",
      "export function run(value: number): number {",
      "  return hostAdd(value) * 2;",
      "}",
      "console.log('callback ready');",
      "",
    ].join("\n"));
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-scalar-callback",
      entry,
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "rc_",
        init_symbol: "rc_init",
        sink_register_symbol: "rc_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
        callback_register_symbol: "rc_set_callback",
      },
      callbacks: [{ name: "hostAdd", params: ["f64"], returns: "f64" }],
      exports: [{
        export: "run",
        symbol: "rc_run",
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

    const probeSource = join(work, "probe.c");
    writeFileSync(probeSource, [
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern void rc_init(void);",
      "extern double rc_run(double value);",
      "extern int32_t rc_set_callback(const char *name, void (*fn)(void), void *ctx);",
      "static double add(void *ctx, double value) {",
      "  return value + *(double *)ctx;",
      "}",
      "int main(void) {",
      "  double increment = 3;",
      "  printf(\"register: %d\\n\", rc_set_callback(\"hostAdd\", (void (*)(void))add, &increment));",
      "  rc_init();",
      "  printf(\"run: %.0f\\n\", rc_run(5));",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(
      "register: 0\ncallback ready\nrun: 16\n",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library callbacks report an unregistered channel as SC4025", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-orphan-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "declare function hostAdd(value: number): number;",
      "export function run(value: number): number { return hostAdd(value); }",
      "console.log('orphan ready');",
      "",
    ].join("\n"));
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-orphan-callback",
      entry,
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "ro_",
        init_symbol: "ro_init",
        sink_register_symbol: "ro_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
        callback_register_symbol: "ro_set_callback",
      },
      callbacks: [{ name: "hostAdd", params: ["f64"], returns: "f64" }],
      exports: [{ export: "run", symbol: "ro_run", params: ["f64"], returns: "f64" }],
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
      "extern void ro_init(void);",
      "extern double ro_run(double value);",
      "extern void ro_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *);",
      "static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t address) {",
      "  (void)ctx; (void)address;",
      "  fputs(\"sink:\", stdout);",
      "  for (size_t i = 0; i < len; i++) {",
      "    if (msg[i] == 1) continue;",
      "    fputc(msg[i] == 31 ? '|' : msg[i], stdout);",
      "  }",
      "  fputc('\\n', stdout);",
      "  longjmp(escape, 1);",
      "}",
      "int main(void) {",
      "  ro_set_panic_sink(sink, NULL);",
      "  ro_init();",
      "  if (setjmp(escape) == 0) (void)ro_run(7);",
      "  puts(\"survived\");",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe([
      "orphan ready",
      "sink:scriptc: library callback 'hostAdd' invoked before registration",
      "|SC4025|ro_run",
      "survived",
      "",
    ].join("\n"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library callbacks synchronously deliver scalar notifications", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-notify-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "declare function hostNote(value: number): void;",
      "export function run(value: number): number {",
      "  hostNote(value);",
      "  return value + 1;",
      "}",
      "console.log('notify ready');",
      "",
    ].join("\n"));
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-scalar-notification",
      entry,
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "rn_",
        init_symbol: "rn_init",
        sink_register_symbol: "rn_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
        callback_register_symbol: "rn_set_callback",
      },
      callbacks: [{ name: "hostNote", params: ["f64"], returns: "void" }],
      exports: [{ export: "run", symbol: "rn_run", params: ["f64"], returns: "f64" }],
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
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern void rn_init(void);",
      "extern double rn_run(double value);",
      "extern int32_t rn_set_callback(const char *name, void (*fn)(void), void *ctx);",
      "static void note(void *ctx, double value) { *(double *)ctx = value * 2; }",
      "int main(void) {",
      "  double observed = 0;",
      "  printf(\"register: %d\\n\", rn_set_callback(\"hostNote\", (void (*)(void))note, &observed));",
      "  rn_init();",
      "  printf(\"run: %.0f observed: %.0f\\n\", rn_run(6), observed);",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(
      "register: 0\nnotify ready\nrun: 7 observed: 12\n",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library callbacks marshal multiple scalars and an i32 result", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-progress-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "declare function hostProgress(done: number, total: number): number;",
      "export function run(done: number): number {",
      "  return hostProgress(done, 10) * 2;",
      "}",
      "console.log('progress ready');",
      "",
    ].join("\n"));
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-progress-callback",
      entry,
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "rp_",
        init_symbol: "rp_init",
        sink_register_symbol: "rp_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
        callback_register_symbol: "rp_set_callback",
      },
      callbacks: [{ name: "hostProgress", params: ["f64", "f64"], returns: "i32" }],
      exports: [{ export: "run", symbol: "rp_run", params: ["f64"], returns: "f64" }],
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
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern void rp_init(void);",
      "extern double rp_run(double value);",
      "extern int32_t rp_set_callback(const char *name, void (*fn)(void), void *ctx);",
      "static int32_t progress(void *ctx, double done, double total) {",
      "  (*(int32_t *)ctx)++;",
      "  return (int32_t)(done + total);",
      "}",
      "int main(void) {",
      "  int32_t calls = 0;",
      "  rp_set_callback(\"hostProgress\", (void (*)(void))progress, &calls);",
      "  rp_init();",
      "  printf(\"run: %.0f calls: %d\\n\", rp_run(5), calls);",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(
      "progress ready\nrun: 30 calls: 1\n",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library callbacks marshal integer plumbing classes", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-mix-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "declare function hostMix(a: number, b: number): number;",
      "export function run(): number { return hostMix(301, -5); }",
      "console.log('mix ready');",
      "",
    ].join("\n"));
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-mixed-callback",
      entry,
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "rm_",
        init_symbol: "rm_init",
        sink_register_symbol: "rm_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
        callback_register_symbol: "rm_set_callback",
      },
      callbacks: [{ name: "hostMix", params: ["u8", "i32"], returns: "u32" }],
      exports: [{ export: "run", symbol: "rm_run", params: [], returns: "f64" }],
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
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern void rm_init(void);",
      "extern double rm_run(void);",
      "extern int32_t rm_set_callback(const char *name, void (*fn)(void), void *ctx);",
      "static uint32_t mix(void *ctx, uint8_t a, int32_t b) {",
      "  return (uint32_t)((int32_t)a * 1000 + b + *(int32_t *)ctx);",
      "}",
      "int main(void) {",
      "  int32_t offset = 7;",
      "  rm_set_callback(\"hostMix\", (void (*)(void))mix, &offset);",
      "  rm_init();",
      "  printf(\"run: %.0f\\n\", rm_run());",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(
      "mix ready\nrun: 45002\n",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library callbacks borrow string spans and marshal booleans", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-note-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "declare function hostNote(text: string, last: boolean): void;",
      "export function run(text: string): void { hostNote(`${text}!`, true); }",
      "console.log('note ready');",
      "",
    ].join("\n"));
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-note-callback",
      entry,
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "nt_",
        init_symbol: "nt_init",
        sink_register_symbol: "nt_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
        callback_register_symbol: "nt_set_callback",
      },
      callbacks: [{ name: "hostNote", params: ["string", "bool"], returns: "void" }],
      exports: [{ export: "run", symbol: "nt_run", params: ["string"], returns: "void" }],
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
      "#include <stddef.h>",
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern void nt_init(void);",
      "extern void nt_run(const uint8_t *text, size_t len);",
      "extern int32_t nt_set_callback(const char *name, void (*fn)(void), void *ctx);",
      "static void note(void *ctx, const uint8_t *text, size_t len, uint8_t last) {",
      "  (*(int32_t *)ctx)++;",
      "  printf(\"note: %.*s last=%u\\n\", (int)len, text, (unsigned)last);",
      "}",
      "int main(void) {",
      "  int32_t calls = 0;",
      "  nt_set_callback(\"hostNote\", (void (*)(void))note, &calls);",
      "  nt_init();",
      "  nt_run((const uint8_t *)\"olá\", 4);",
      "  printf(\"calls: %d\\n\", calls);",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(
      "note ready\nnote: olá! last=1\ncalls: 1\n",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library callbacks borrow byte spans and marshal u32 values", async () => {
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-chunk-"));
  try {
    const entry = join(work, "lib.ts");
    writeFileSync(entry, [
      "declare function hostChunk(chunk: Uint8Array, seq: number): void;",
      "export function run(): void {",
      "  const chunk = new Uint8Array(3);",
      "  chunk[0] = 65; chunk[1] = 66; chunk[2] = 67;",
      "  hostChunk(chunk, 4294967298);",
      "}",
      "console.log('chunk ready');",
      "",
    ].join("\n"));
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      profile_format: 1,
      name: "rust-chunk-callback",
      entry,
      emission: "rust",
      optimization: "dev",
      abi: {
        prefix: "ck_",
        init_symbol: "ck_init",
        sink_register_symbol: "ck_set_panic_sink",
        collect_symbol: null,
        result_reset_symbol: null,
        callback_register_symbol: "ck_set_callback",
      },
      callbacks: [{ name: "hostChunk", params: ["bytes", "u32"], returns: "void" }],
      exports: [{ export: "run", symbol: "ck_run", params: [], returns: "void" }],
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
      "#include <stddef.h>",
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern void ck_init(void);",
      "extern void ck_run(void);",
      "extern int32_t ck_set_callback(const char *name, void (*fn)(void), void *ctx);",
      "static void chunk(void *ctx, const uint8_t *bytes, size_t len, uint32_t seq) {",
      "  (*(int32_t *)ctx)++;",
      "  printf(\"chunk: %.*s len=%zu seq=%u\\n\", (int)len, bytes, len, seq);",
      "}",
      "int main(void) {",
      "  int32_t calls = 0;",
      "  ck_set_callback(\"hostChunk\", (void (*)(void))chunk, &calls);",
      "  ck_init();",
      "  ck_run();",
      "  printf(\"calls: %d\\n\", calls);",
      "  return 0;",
      "}",
      "",
    ].join("\n"));
    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      probeSource,
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    expect(execFileSync(probe, { encoding: "utf8" })).toBe(
      "chunk ready\nchunk: ABC len=3 seq=2\ncalls: 1\n",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("Rust library archives pass the official host callback acceptance fixture", async () => {
  const fixture = resolve("tests/library-mode/callbacks");
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-callbacks-"));
  try {
    const profile = JSON.parse(
      readFileSync(join(fixture, "profile.json"), "utf8"),
    ) as Record<string, unknown>;
    profile["entry"] = join(fixture, "lib.ts");
    profile["emission"] = "rust";
    profile["optimization"] = "dev";
    const profilePath = join(work, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = await compileLibrary({ profilePath, outDir: work });
    expect(
      result.ok,
      result.ok
        ? undefined
        : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;

    const probe = join(work, "probe");
    execFileSync("clang", [
      "-std=c11",
      join(fixture, "probe.c"),
      result.archivePath,
      "-lm",
      "-ldl",
      "-lpthread",
      "-o",
      probe,
    ]);
    const run = spawnSync(probe, ["run"], { encoding: "utf8" });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe([
      "reg unknown: -1",
      "reg null-name: -1",
      "reg emitChunk: 0",
      "reg progress: 0",
      "reg note: 0",
      "reg mix: 0",
      "callbacks ready",
      "stream(4,3) = 31",
      "log_a: 4 chunk(s), thread_ok=1",
      "  seq=0 len=3 bytes=A3!",
      "  seq=1 len=3 bytes=B4!",
      "  seq=2 len=3 bytes=C5!",
      "  seq=3 len=3 bytes=D6!",
      "notes: [chunk 0 away last=0][chunk 1 away last=0][chunk 2 away last=0][chunk 3 away last=1]",
      "stream(2,7) = 23",
      "log_a: 2 chunk(s), thread_ok=1",
      "  seq=0 len=3 bytes=A7!",
      "  seq=1 len=3 bytes=B8!",
      "notes: [chunk 0 away last=0][chunk 1 away last=1]",
      "askHost(5) = 64",
      "reg emitChunk again: 0",
      "stream(1,9) = 12",
      "log_a after reroute: 0 chunk(s)",
      "log_b: 1 chunk(s), thread_ok=1",
      "  seq=0 len=3 bytes=A9!",
      "reg emitChunk clear: 0",
      "sink[1]:",
      "text=[scriptc: library callback 'emitChunk' invoked before registration",
      "]",
      "code=[SC4025]",
      "symbol=[cb_stream]",
      "fields=3 text_printable=1",
      "addr: nonzero",
      "survived, sink_calls=1",
      "",
    ].join("\n"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
