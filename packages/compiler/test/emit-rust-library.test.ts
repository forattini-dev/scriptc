import { execFileSync } from "node:child_process";
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
