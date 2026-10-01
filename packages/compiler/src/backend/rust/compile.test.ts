import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { compileRust, compileRustLibrary, rustRuntimeTargetDir } from "./compile.js";

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: commands.run });
  return { execFile };
});
vi.mock("../native-build-slot.js", () => ({ withNativeBuildSlot: async (action: () => Promise<unknown>) => action() }));

afterEach(() => {
  vi.unstubAllEnvs();
  commands.run.mockReset();
});

describe("Rust runtime cache identity", () => {
  test("isolates worktrees and runtime feature sets", () => {
    const plain = rustRuntimeTargetDir("/cache", "/worktree/a/runtime", [], false);
    const island = rustRuntimeTargetDir(
      "/cache",
      "/worktree/a/runtime",
      ["island-eval"],
      false,
    );
    const otherWorktree = rustRuntimeTargetDir(
      "/cache",
      "/worktree/b/runtime",
      ["island-eval"],
      false,
    );

    expect(new Set([plain, island, otherWorktree])).toHaveLength(3);
  });

  test("canonicalizes duplicate features and separates library artifacts", () => {
    const executable = rustRuntimeTargetDir(
      "/cache",
      "/runtime",
      ["island-eval", "island-eval"],
      false,
    );
    const canonical = rustRuntimeTargetDir(
      "/cache",
      "/runtime",
      ["island-eval"],
      false,
    );
    const library = rustRuntimeTargetDir(
      "/cache",
      "/runtime",
      ["island-eval"],
      true,
    );

    expect(executable).toBe(canonical);
    expect(library).not.toBe(executable);
  });
});

describe("Rust AddressSanitizer build orchestration", () => {
  async function fixture(action: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "scriptc-rust-sanitizer-"));
    vi.stubEnv("SCRIPTC_CACHE_DIR", join(directory, "cache"));
    vi.stubEnv("SCRIPTC_TARGET", "native");
    vi.stubEnv("SCRIPTC_RUST_SAN_TOOLCHAIN", "nightly-2026-09-26");
    vi.stubEnv("RUSTUP_TOOLCHAIN", "1.98.1");
    vi.stubEnv("RUSTC", "");
    vi.stubEnv("RUSTC_WRAPPER", "");
    vi.stubEnv("RUSTC_WORKSPACE_WRAPPER", "");
    vi.stubEnv("RUSTFLAGS", "");
    vi.stubEnv("CARGO_ENCODED_RUSTFLAGS", "");
    commands.run.mockImplementation(async (command: string, args: string[]) => {
      if (command === "rustup" && args[0] === "which") return { stdout: "/mock/nightly/bin/rustc\n", stderr: "" };
      if (command === "rustup" && args.includes("-vV")) return {
        stdout: "rustc 1.100.0-nightly\nhost: x86_64-unknown-linux-gnu\nrelease: 1.100.0-nightly\n", stderr: "",
      };
      if (args.includes("build")) return {
        stdout: JSON.stringify({ reason: "compiler-artifact", target: { name: "scriptc_runtime" }, filenames: [join(directory, "libscriptc_runtime.rlib")] }), stderr: "",
      };
      return { stdout: "", stderr: "" };
    });
    try { await action(directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  test("instruments both the runtime and generated program with the same pinned nightly", async () => {
    await fixture(async directory => {
      await compileRust({ sourcePath: join(directory, "program.rs"), outPath: join(directory, "program"), optimization: "dev", sanitize: true });
      const cargo = commands.run.mock.calls.find(([, args]) => args.includes("build"));
      const rustc = commands.run.mock.calls.find(([, args]) => args.includes("--crate-name"));
      if (cargo === undefined || rustc === undefined) throw new Error("runtime and program commands must both run");
      expect(cargo?.[0]).toBe("rustup");
      expect(cargo?.[1].slice(0, 4)).toEqual(["run", "nightly-2026-09-26", "cargo", "build"]);
      expect(cargo?.[1]).toEqual(expect.arrayContaining(["--target", "x86_64-unknown-linux-gnu"]));
      expect(cargo?.[2].env.CARGO_ENCODED_RUSTFLAGS.split("\x1f")).toContain("-Zsanitizer=address");
      expect(cargo[2].env.RUSTC).toBe("/mock/nightly/bin/rustc");
      expect(cargo[2].env.RUSTC_WRAPPER).toBe("");
      expect(cargo[2].env.RUSTC_WORKSPACE_WRAPPER).toBe("");
      expect(rustc?.[1].slice(0, 3)).toEqual(["run", "nightly-2026-09-26", "rustc"]);
      expect(rustc?.[1]).toEqual(expect.arrayContaining(["--target", "x86_64-unknown-linux-gnu", "-Zsanitizer=address", "force-frame-pointers=yes"]));
      expect(rustc[1]).toContain(`dependency=${join(cargo[1][cargo[1].indexOf("--target-dir") + 1], "x86_64-unknown-linux-gnu", "debug", "deps")}`);
      expect(process.env["RUSTUP_TOOLCHAIN"]).toBe("1.98.1");
    });
  });

  test("separates instrumented runtime artifacts from the plain runtime cache", async () => {
    await fixture(async directory => {
      const options = { sourcePath: join(directory, "program.rs"), outPath: join(directory, "program"), optimization: "dev" as const };
      await compileRust(options);
      await compileRust({ ...options, sanitize: true });
      const cargo = commands.run.mock.calls.filter(([, args]) => args.includes("build"));
      const targets = cargo.map(([, args]) => args[args.indexOf("--target-dir") + 1]);
      expect(targets).toHaveLength(2);
      expect(targets[0]).not.toBe(targets[1]);
      expect(cargo[0]?.[0]).toBe("cargo");
    });
  });

  test("instruments library archives without stripping ASan debugging information", async () => {
    await fixture(async directory => {
      await compileRustLibrary({ sourcePath: join(directory, "program.rs"), outPath: join(directory, "program.a"), sanitize: true });
      const rustc = commands.run.mock.calls.find(([, args]) => args.includes("--crate-type"));
      expect(rustc?.[1]).toEqual(expect.arrayContaining(["--crate-type", "staticlib", "-Zsanitizer=address", "debuginfo=1"]));
      expect(rustc?.[1]).not.toContain("strip=symbols");
    });
  });

  test("reports an actionable dated-toolchain configuration error instead of an unimplemented refusal", async () => {
    await fixture(async directory => {
      vi.stubEnv("SCRIPTC_RUST_SAN_TOOLCHAIN", "");
      await expect(compileRust({ sourcePath: join(directory, "program.rs"), outPath: join(directory, "program"), sanitize: true }))
        .rejects.toThrow("SCRIPTC_RUST_SAN_TOOLCHAIN");
      expect(commands.run).not.toHaveBeenCalled();
    });
  });

  test.each(["nightly", "stable", "1.98.1", "nightly-2026-02-30"])("rejects unpinned or invalid toolchain %s before running Cargo", async toolchain => {
    await fixture(async directory => {
      vi.stubEnv("SCRIPTC_RUST_SAN_TOOLCHAIN", toolchain);
      await expect(compileRust({ sourcePath: join(directory, "program.rs"), outPath: join(directory, "program"), sanitize: true }))
        .rejects.toThrow("SCRIPTC_RUST_SAN_TOOLCHAIN");
      expect(commands.run).not.toHaveBeenCalled();
    });
  });

  test("reports how to provision an unavailable dated nightly", async () => {
    await fixture(async directory => {
      commands.run.mockRejectedValueOnce(new Error("toolchain is not installed"));
      await expect(compileRust({ sourcePath: join(directory, "program.rs"), outPath: join(directory, "program"), sanitize: true }))
        .rejects.toThrow("rustup toolchain install nightly-2026-09-26 --profile minimal");
      expect(commands.run).toHaveBeenCalledTimes(1);
    });
  });

  test("rejects unsupported native sanitizer hosts", async () => {
    await fixture(async directory => {
      commands.run.mockResolvedValueOnce({ stdout: "host: x86_64-pc-windows-msvc\nrelease: 1.100.0-nightly\n", stderr: "" });
      await expect(compileRust({ sourcePath: join(directory, "program.rs"), outPath: join(directory, "program"), sanitize: true }))
        .rejects.toThrow("reported host 'x86_64-pc-windows-msvc'");
      expect(commands.run).toHaveBeenCalledTimes(1);
    });
  });

  test("preserves effective Cargo flags in both builds and their cache identity", async () => {
    await fixture(async directory => {
      const options = { sourcePath: join(directory, "program.rs"), outPath: join(directory, "program"), sanitize: true };
      vi.stubEnv("RUSTFLAGS", "-C panic=abort");
      // Encoded flags take precedence, including an explicitly empty value.
      vi.stubEnv("CARGO_ENCODED_RUSTFLAGS", "-C\x1fcodegen-units=1");
      await compileRust(options);
      vi.stubEnv("CARGO_ENCODED_RUSTFLAGS", "-C\x1fcodegen-units=2");
      await compileRust(options);
      const cargo = commands.run.mock.calls.filter(([, args]) => args.includes("build"));
      const rustc = commands.run.mock.calls.filter(([, args]) => args.includes("--crate-name"));
      expect(rustc[0]?.[1]).toContain("codegen-units=1");
      expect(rustc[0]?.[1]).not.toContain("panic=abort");
      expect(cargo[0]?.[2].env.CARGO_ENCODED_RUSTFLAGS).toContain("codegen-units=1");
      expect(cargo[0]?.[1][cargo[0]?.[1].indexOf("--target-dir") + 1]).not.toBe(cargo[1]?.[1][cargo[1]?.[1].indexOf("--target-dir") + 1]);
    });
  });

  test("rejects compiler wrappers instead of silently instrumenting with another toolchain", async () => {
    await fixture(async directory => {
      vi.stubEnv("RUSTC_WRAPPER", "/custom/rustc-wrapper");
      await expect(compileRust({ sourcePath: join(directory, "program.rs"), outPath: join(directory, "program"), sanitize: true }))
        .rejects.toThrow("RUSTC_WRAPPER");
      expect(commands.run).not.toHaveBeenCalled();
    });
  });
});
