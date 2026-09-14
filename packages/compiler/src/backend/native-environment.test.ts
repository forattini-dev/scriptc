
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, expect, test as vitestTest } from "vitest";
import { cacheTargetIdentity, compileC, executableSectionEliminationFlags, executableNativeEnvironmentFingerprint, parseLinkTraceFiles, resolveBuildCacheRoot, toolchainEnvironmentCachePolicy, toolchainEnvironmentFingerprint, vendorCacheBuildIdentity, vendorCacheTargetFlavor } from "./native-toolchain.js";
import { isolateNativeToolchainEnvironment } from "./native-toolchain.test-support.js";

const scratch: string[] = [];
const TEST_CACHE_IDENTITY = "cc-cache-tests-v1";
const restoreToolchainEnvironment = isolateNativeToolchainEnvironment();
const originalTrustedCompilerWrapper = process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"];

/** The cache suite mutates process-wide compiler state and must stay serial
 * within one worker, but CI/Sandbox workers can safely divide its independent
 * tests across processes. Unset runs the complete file for ordinary focused
 * use; i/n uses the same stable hash partition as the corpus harness. */
function cacheTestSelected(name: string): boolean {
  const spec = process.env["SCRIPTC_CACHE_TEST_SHARD"];
  if (spec === undefined || spec === "") return true;
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  if (match === null) throw new Error(`invalid SCRIPTC_CACHE_TEST_SHARD '${spec}' (expected i/n)`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || total < 1 || index > total) {
    throw new Error(`invalid SCRIPTC_CACHE_TEST_SHARD '${spec}' (expected 1 <= i <= n)`);
  }
  return createHash("sha1").update(name).digest().readUInt32BE(0) % total === index - 1;
}

const test = Object.assign(
  (name: string, ...args: unknown[]) =>
    Reflect.apply(cacheTestSelected(name) ? vitestTest : vitestTest.skip, undefined, [name, ...args]),
  {
    skipIf: (condition: boolean) => (name: string, ...args: unknown[]) =>
      Reflect.apply(condition || !cacheTestSelected(name) ? vitestTest.skip : vitestTest, undefined, [
        name,
        ...args,
      ]),
  },
) as typeof vitestTest;
const executableOnPath = (name: string): string | undefined =>
  (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((entry) => join(entry === "" ? process.cwd() : entry, name))
    .find((candidate) => existsSync(candidate));
const zigExecutable = executableOnPath("zig");
const clangExecutable = executableOnPath("clang");
const arExecutable = executableOnPath("ar");

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  restoreToolchainEnvironment();
});

afterEach(() => {
  if (originalTrustedCompilerWrapper === undefined) {
    delete process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"];
  } else {
    process.env["SCRIPTC_TEST_TRUST_COMPILER_WRAPPER"] = originalTrustedCompilerWrapper;
  }
});

test("the production cache root follows overrides, platform defaults, and the hard disable", () => {
  expect(resolveBuildCacheRoot({ SCRIPTC_NO_CACHE: "1" }, "linux", "/home/tester")).toBeNull();
  expect(resolveBuildCacheRoot({ SCRIPTC_CACHE_DIR: "" }, "linux", "/home/tester")).toBeNull();
  expect(resolveBuildCacheRoot({ SCRIPTC_CACHE_DIR: "/var/tmp/custom" }, "linux", "/home/tester")).toBe(
    "/var/tmp/custom",
  );
  expect(resolveBuildCacheRoot({ XDG_CACHE_HOME: "/var/tmp/xdg" }, "linux", "/home/tester")).toBe(
    "/var/tmp/xdg/scriptc/build",
  );
  expect(resolveBuildCacheRoot({}, "darwin", "/Users/tester")).toBe(
    "/Users/tester/Library/Caches/scriptc/build",
  );
  expect(resolveBuildCacheRoot({ LOCALAPPDATA: "/Users/tester/AppData/Local" }, "win32", "/Users/tester")).toBe(
    "/Users/tester/AppData/Local/scriptc/cache/build",
  );
});

test("executable section elimination flags are target-aware and never enter library recipes", () => {
  expect(executableSectionEliminationFlags("darwin")).toEqual({
    compile: [],
    link: ["-Wl,-dead_strip"],
  });
  expect(executableSectionEliminationFlags("linux")).toEqual({
    compile: ["-ffunction-sections", "-fdata-sections"],
    link: ["-Wl,--gc-sections"],
  });
  expect(executableSectionEliminationFlags("win32")).toEqual({
    compile: ["-ffunction-sections", "-fdata-sections"],
    link: ["-Wl,--gc-sections"],
  });
  expect(executableSectionEliminationFlags("wasi")).toEqual({ compile: [], link: [] });
});

test.skipIf(process.platform === "win32")(
  "the early executable identity follows a compiler selected behind a stable driver",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-effective-compiler-"));
    scratch.push(dir);
    const binDir = join(dir, "bin");
    const selector = join(dir, "selected");
    const firstCompiler = join(dir, "clang-first");
    const secondCompiler = join(dir, "clang-second");
    await mkdir(binDir);
    await Promise.all([
      writeFile(firstCompiler, "#!/bin/sh\nexit 0\n"),
      writeFile(secondCompiler, "#!/bin/sh\nexit 0\n"),
      writeFile(
        join(binDir, "clang"),
        "#!/bin/sh\nselected=$(cat \"$SCRIPTC_TEST_EFFECTIVE_COMPILER\")\nprintf '\"%s\" \"-cc1\"\\n' \"$selected\" >&2\n",
      ),
      writeFile(selector, `${firstCompiler}\n`),
    ]);
    await Promise.all([
      chmod(firstCompiler, 0o755),
      chmod(secondCompiler, 0o755),
      chmod(join(binDir, "clang"), 0o755),
    ]);
    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}`,
      SCRIPTC_TEST_EFFECTIVE_COMPILER: selector,
    };

    const first = await executableNativeEnvironmentFingerprint(env);
    expect(await executableNativeEnvironmentFingerprint(env)).toBe(first);
    await writeFile(selector, `${secondCompiler}\n`);
    const second = await executableNativeEnvironmentFingerprint(env);

    expect(second).not.toBe(first);
  },
);

test("native cache identities separate host architectures while cross targets remain explicit", () => {
  expect(cacheTargetIdentity({ target: null }, "darwin", "arm64")).toBe("native:darwin:arm64");
  expect(cacheTargetIdentity({ target: null }, "darwin", "x64")).toBe("native:darwin:x64");
  expect(cacheTargetIdentity({ target: "x86_64-linux-gnu.2.36" }, "darwin", "arm64")).toBe(
    "cross:x86_64-linux-gnu.2.36",
  );
  expect(vendorCacheTargetFlavor({ target: null }, "darwin", "arm64")).toBe(
    "native-darwin-arm64",
  );
  expect(vendorCacheTargetFlavor({ target: null }, "darwin", "x64")).toBe(
    "native-darwin-x64",
  );
  expect(
    vendorCacheTargetFlavor({ target: "x86_64-linux-gnu.2.36" }, "darwin", "arm64"),
  ).toBe("x86_64-linux-gnu.2.36");
});

test.skipIf(
  process.platform === "win32" || zigExecutable === undefined ||
  clangExecutable === undefined || arExecutable === undefined,
)("targetless Zig vendor caches are separate from host-clang and reusable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-zig-vendor-cache-"));
  scratch.push(dir);
  const cacheRoot = join(dir, "cache");
  const vendorRoot = join(dir, "vendor-cache");
  const cPath = join(dir, "program.c");
  const oldCacheDir = process.env["SCRIPTC_CACHE_DIR"];
  const oldNoCache = process.env["SCRIPTC_NO_CACHE"];
  const oldVendorCacheDir = process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
  const oldCc = process.env["SCRIPTC_CC"];
  const oldTarget = process.env["SCRIPTC_TARGET"];

  try {
    await writeFile(cPath, "int main(void) { return 0; }\n");
    process.env["SCRIPTC_CACHE_DIR"] = cacheRoot;
    process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = vendorRoot;
    delete process.env["SCRIPTC_NO_CACHE"];
    delete process.env["SCRIPTC_TARGET"];

    process.env["SCRIPTC_CC"] = "clang";
    await compileC({
      cPath,
      outPath: join(dir, "host"),
      cacheIdentity: TEST_CACHE_IDENTITY,
      dynamic: true,
      net: true,
      http: true,
      tls: true,
      zlib: true,
      // Keep the complete executable tier out of this test: the second Zig
      // invocation must walk the vendor cache and prove its artifacts are
      // reusable independently of the output path.
      systemLibraries: ["m"],
    });
    const hostEngine = (await readdir(vendorRoot)).find((name) =>
      /^3c8f3d689539-plain-/.test(name)
    );
    const hostTls = (await readdir(vendorRoot)).find((name) => name.startsWith("mbedtls-"));
    expect(hostEngine).toBeDefined();
    expect(hostTls).toBeDefined();

    process.env["SCRIPTC_CC"] = "zigcc";
    const zigOptions = {
      cPath,
      cacheIdentity: TEST_CACHE_IDENTITY,
      dynamic: true,
      net: true,
      http: true,
      tls: true,
      zlib: true,
      systemLibraries: ["m"],
    } as const;
    await compileC({ ...zigOptions, outPath: join(dir, "zig-first") });

    let vendorEntries = await readdir(vendorRoot);
    expect(vendorEntries.filter((name) => /^3c8f3d689539-plain-/.test(name))).toHaveLength(2);
    expect(vendorEntries.filter((name) => name.startsWith("mbedtls-")).length).toBe(2);
    // Host clang uses system zlib, so only the Zig build materializes a zlib
    // object family in the shared vendor root.
    expect(vendorEntries.filter((name) => name.startsWith("zlib-")).length).toBe(1);
    // Invalidate the host archive. A targetless Zig rebuild must continue to
    // use the separately keyed Zig archive instead of repairing or consuming
    // the host-clang entry.
    await writeFile(join(vendorRoot, hostEngine!, "libqjs.a"), "host archive intentionally invalid\n");
    await writeFile(join(vendorRoot, hostTls!, "libmbedtls.a"), "host archive intentionally invalid\n");
    await compileC({ ...zigOptions, outPath: join(dir, "zig-second") });
    vendorEntries = await readdir(vendorRoot);
    expect(vendorEntries.filter((name) => /^3c8f3d689539-plain-/.test(name))).toHaveLength(2);
    expect(await readFile(join(vendorRoot, hostEngine!, "libqjs.a"), "utf8")).toBe(
      "host archive intentionally invalid\n",
    );
    expect(await readFile(join(vendorRoot, hostTls!, "libmbedtls.a"), "utf8")).toBe(
      "host archive intentionally invalid\n",
    );
  } finally {
    if (oldCacheDir === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = oldCacheDir;
    if (oldNoCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = oldNoCache;
    if (oldVendorCacheDir === undefined) delete process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"];
    else process.env["SCRIPTC_TEST_VENDOR_CACHE_DIR"] = oldVendorCacheDir;
    if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = oldCc;
    if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = oldTarget;
  }
}, 600_000);

test("Zig COFF dry-run parsing retains every linker input on its single command line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-link-trace-"));
  scratch.push(dir);
  const probeDir = join(dir, "probe");
  const first = join(dir, "crt2.obj");
  const second = join(dir, "compiler_rt.lib");
  const third = join(dir, "kernel32.lib");
  await mkdir(probeDir);
  await Promise.all([
    writeFile(join(probeDir, "empty.o"), "probe"),
    writeFile(first, "first"),
    writeFile(second, "second"),
    writeFile(third, "third"),
  ]);

  const output = [
    "lld-link",
    `\"${join(probeDir, "empty.o")}\"`,
    `\"${first}\"`,
    `\"${second}\"`,
    `\"${third}\"`,
  ].join(" ");
  expect(await parseLinkTraceFiles(output, probeDir, probeDir, true)).toEqual(
    [first, second, third].sort(),
  );
});

test("the toolchain environment joins cache identities", () => {
  const base = toolchainEnvironmentFingerprint({ PATH: "/usr/bin", CPATH: "/headers/one" });
  expect(toolchainEnvironmentFingerprint({ PATH: "/usr/bin", CPATH: "/headers/two" })).not.toBe(base);
  expect(toolchainEnvironmentFingerprint({ ZIG_LIB_DIR: "/zig/one" })).not.toBe(
    toolchainEnvironmentFingerprint({ ZIG_LIB_DIR: "/zig/two" }),
  );
  expect(toolchainEnvironmentFingerprint({ ZIG_LIBC: "/libc/one.conf" })).not.toBe(
    toolchainEnvironmentFingerprint({ ZIG_LIBC: "/libc/two.conf" }),
  );
  // PATH is deliberately absent from this generic environment hash: the
  // resolved executable identity is keyed separately, while the compiler
  // must still resolve on every cache-enabled call.
  expect(toolchainEnvironmentFingerprint({ PATH: "", CPATH: "/headers/one" })).toBe(base);
  expect(
    toolchainEnvironmentFingerprint({
      PATH: "/usr/bin",
      CPATH: "/headers/one",
      SCRIPTC_CACHE_MAX_MB: "1",
    }),
  ).toBe(base);

  expect(toolchainEnvironmentCachePolicy({ MACOSX_DEPLOYMENT_TARGET: "14.0" })).toEqual({
    completeArtifacts: true,
    runtimeObjects: true,
  });
  expect(toolchainEnvironmentCachePolicy({ LIBRARY_PATH: "/libraries" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: true,
  });
  expect(toolchainEnvironmentCachePolicy({ CPATH: "/headers" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: false,
  });
  expect(toolchainEnvironmentCachePolicy({ LD_LIBRARY_PATH: "/libraries" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: false,
  });
  // scriptc invokes its compiler and archiver directly; conventional build-
  // system variables do not alter those commands.
  expect(toolchainEnvironmentCachePolicy({ CFLAGS: "-I/headers" })).toEqual({
    completeArtifacts: true,
    runtimeObjects: true,
  });
  expect(toolchainEnvironmentCachePolicy({ ZIG_LIB_DIR: "/zig/lib" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: false,
  });
  expect(toolchainEnvironmentCachePolicy({ ZIG_LIBC: "/zig/libc.conf" })).toEqual({
    completeArtifacts: false,
    runtimeObjects: false,
  });

  expect(vendorCacheBuildIdentity(base, "compiler-one", "sources-one")).not.toBe(
    vendorCacheBuildIdentity(base, "compiler-two", "sources-one"),
  );
  expect(vendorCacheBuildIdentity(base, "compiler-one", "sources-one")).not.toBe(
    vendorCacheBuildIdentity(
      toolchainEnvironmentFingerprint({ MACOSX_DEPLOYMENT_TARGET: "11.0" }),
      "compiler-one",
      "sources-one",
    ),
  );
  expect(vendorCacheBuildIdentity(base, "compiler-one", "sources-one")).not.toBe(
    vendorCacheBuildIdentity(base, "compiler-one", "sources-two"),
  );
});
