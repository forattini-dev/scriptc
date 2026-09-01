import { describe, expect, test } from "vitest";
import { rustRuntimeTargetDir } from "./compile.js";

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
