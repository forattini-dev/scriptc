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
