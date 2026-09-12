import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { pruneBuildCache } from "./native-toolchain.js";

const scratch: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "scriptc-cache-ownership-"));
  scratch.push(path);
  return path;
}
async function put(root: string, name: string, size: number, age: number): Promise<string> {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(size, 7));
  const time = new Date(age * 1000);
  await utimes(path, time, time);
  return path;
}

test("native eviction preserves Cargo transactions and foreign cache namespaces", async () => {
  const cache = await root();
  vi.stubEnv("SCRIPTC_CACHE_MAX_MB", "0.001");
  const cargo = await Promise.all([
    "cargo-target/debug/deps/libdependency.rlib",
    "rust-runtime-v2/identity/debug/.fingerprint/dependency/stamp",
    "rust-runtime-v2-library/identity/release/libscriptc_runtime.rlib",
    "custom-cargo-target/debug/deps/libdependency.rlib",
    "foreign/retained-artifact",
  ].map((path) => put(cache, path, 4096, 1)));
  const native = await put(cache, "bin/recent", 512, 2);
  await pruneBuildCache(cache);
  for (const path of cargo) expect(await readFile(path)).toEqual(Buffer.alloc(4096, 7));
  expect((await stat(native)).size).toBe(512);
});

test("owned artifact tiers still evict oldest files to the configured watermark", async () => {
  const cache = await root();
  vi.stubEnv("SCRIPTC_CACHE_MAX_MB", "0.002");
  const old = await put(cache, "obj/set/runtime.o", 900, 1);
  const middle = await put(cache, "early-exe/identity/stamp.json", 900, 2);
  const recent = await put(cache, "bin/recent", 900, 3);
  await pruneBuildCache(cache);
  await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(middle)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(recent)).size).toBe(900);
});

test("eviction does not follow namespace symlinks or remove active publications", async () => {
  const cache = await root();
  const outside = await root();
  vi.stubEnv("SCRIPTC_CACHE_MAX_MB", "0.001");
  const retained = await put(outside, "dependency.rlib", 4096, 1);
  await symlink(outside, join(cache, "vendor"), "dir");
  const active = await put(cache, "bin/.scriptc-publishing", 4096, 1);
  const expired = await put(cache, "bin/expired", 4096, 1);
  await pruneBuildCache(cache);
  expect((await stat(retained)).size).toBe(4096);
  expect((await stat(active)).size).toBe(4096);
  await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an explicitly configured Cargo target inside an artifact namespace is excluded", async () => {
  const cache = await root();
  vi.stubEnv("SCRIPTC_CACHE_MAX_MB", "0.001");
  vi.stubEnv("CARGO_TARGET_DIR", join(cache, "obj", "cargo"));
  const cargo = await put(cache, "obj/cargo/debug/deps/libdependency.rlib", 4096, 1);
  const expired = await put(cache, "obj/runtime/expired.o", 4096, 1);
  await pruneBuildCache(cache);
  expect((await stat(cargo)).size).toBe(4096);
  await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
});
