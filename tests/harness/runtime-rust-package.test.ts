import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "./file-stdio.js";

// This lane exercises the POSIX tar CLI used by the Linux/macOS package gate.
test.skipIf(process.platform === "win32")("Rust runtime npm tarball passes Cargo check with its vendored dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-runtime-package-"));
  try {
    const packed = await runFileStdio("pnpm", [
      "--dir", resolve("packages/runtime-rust"), "pack", "--pack-destination", directory,
    ]);
    expect(packed.code, packed.stderr.toString()).toBe(0);
    expect(packed.signal).toBeNull();
    const archives = (await readdir(directory)).filter(file => file.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    const archive = archives[0];
    if (archive === undefined) throw new Error("Rust runtime npm tarball is missing");
    const extracted = await runFileStdio("tar", ["-xzf", join(directory, archive), "-C", directory]);
    expect(extracted.code, extracted.stderr.toString()).toBe(0);
    expect(extracted.signal).toBeNull();
    const cargo = await runFileStdio("cargo", [
      "check", "--locked", "--offline", "--no-default-features",
      "--manifest-path", join(directory, "package", "Cargo.toml"),
    ]);
    expect(cargo.code, cargo.stderr.toString()).toBe(0);
    expect(cargo.signal).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
