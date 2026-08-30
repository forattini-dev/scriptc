import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary } from "../src/index.js";

test("Rust library archives expose the identity recorded by their sidecar", async () => {
  const fixture = resolve("tests/library-mode/fences-attest");
  const work = mkdtempSync(join(tmpdir(), "scriptc-rust-library-sidecar-"));
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
    expect(result.sidecarPath).toBeDefined();

    const sidecar = JSON.parse(readFileSync(result.sidecarPath!, "utf8")) as {
      build_id: string;
      abi_version: number;
    };
    const probeSource = join(work, "probe.c");
    writeFileSync(probeSource, [
      "#include <inttypes.h>",
      "#include <stdint.h>",
      "#include <stdio.h>",
      "extern uint64_t kf_build_id(void);",
      "extern uint32_t kf_abi_version(void);",
      "int main(void) {",
      "  printf(\"%016\" PRIx64 \" %\" PRIu32 \"\\n\", kf_build_id(), kf_abi_version());",
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
      `${sidecar.build_id} ${sidecar.abi_version}\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
