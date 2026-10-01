import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { compile, compileLibrary } from "../src/index.js";
import { compileRust, compileRustLibrary, RustBuildConfigurationError } from "../src/backend/rust/compile.js";

vi.mock("../src/backend/rust/compile.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/backend/rust/compile.js")>();
  return { ...original, compileRust: vi.fn(), compileRustLibrary: vi.fn() };
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-rust-san-api-"));
  vi.stubEnv("SCRIPTC_TARGET", "");
  vi.stubEnv("SCRIPTC_CACHE_DIR", join(directory, "cache"));
  try { await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test.each([false, true])("executable API passes sanitize=%s to the Rust backend", async sanitize => {
  await fixture(async directory => {
    const result = await compile(resolve("tests/corpus/3321-json-stringify-no-arguments.js"), {
      backend: "rust", allowEngine: false, sanitize, optimization: "dev", outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    expect(compileRust).toHaveBeenCalledWith(expect.objectContaining({ sanitize, optimization: "dev" }));
  });
});

test("executable API reports sanitizer provisioning as SC3002, not SC3001 or an ICE", async () => {
  await fixture(async directory => {
    vi.mocked(compileRust).mockRejectedValueOnce(new RustBuildConfigurationError("configure SCRIPTC_RUST_SAN_TOOLCHAIN"));
    const result = await compile(resolve("tests/corpus/3321-json-stringify-no-arguments.js"), {
      backend: "rust", sanitize: true, outDir: directory, outPath: join(directory, "program"),
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "SC3002", message: "configure SCRIPTC_RUST_SAN_TOOLCHAIN" }] });
  });
});

test.each([false, true])("library API passes sanitize=%s to the Rust backend", async sanitize => {
  await fixture(async directory => {
    const profile = JSON.parse(await readFile(resolve("tests/library-mode/scalars/profile.json"), "utf8"));
    const profilePath = join(directory, "profile.json");
    await writeFile(profilePath, JSON.stringify({ ...profile, entry: resolve("tests/library-mode/scalars/lib.ts"), emission: "rust", optimization: "dev" }));
    const result = await compileLibrary({ profilePath, outDir: directory, sanitize });
    expect(result.ok, result.ok ? undefined : result.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")).toBe(true);
    expect(compileRustLibrary).toHaveBeenCalledWith(expect.objectContaining({ sanitize, optimization: "dev" }));
  });
});

test("library API reports sanitizer provisioning as SC3002 instead of an ICE", async () => {
  await fixture(async directory => {
    const profile = JSON.parse(await readFile(resolve("tests/library-mode/scalars/profile.json"), "utf8"));
    const profilePath = join(directory, "profile.json");
    await writeFile(profilePath, JSON.stringify({ ...profile, entry: resolve("tests/library-mode/scalars/lib.ts"), emission: "rust", optimization: "dev" }));
    vi.mocked(compileRustLibrary).mockRejectedValueOnce(new RustBuildConfigurationError("configure SCRIPTC_RUST_SAN_TOOLCHAIN"));
    const result = await compileLibrary({ profilePath, outDir: directory, sanitize: true });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "SC3002", message: "configure SCRIPTC_RUST_SAN_TOOLCHAIN" }] });
  });
});
