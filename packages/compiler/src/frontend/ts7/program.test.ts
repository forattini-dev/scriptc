import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { API } from "typescript/unstable/sync";
import { Ts7Host } from "./program-adapter.js";

test("disposing a shared-host program unloads its project and preserves live siblings", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-ts7-lifecycle-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, "export const answer: number = 42;\n");
  const host = new Ts7Host({ cwd: dir });
  // Observe the real server's project inventory, not calls to our cleanup.
  const api: API = Reflect.get(host, "api");
  const projects = (): string[] => {
    const snapshot = api.updateSnapshot({});
    try { return snapshot.getProjects().map((p) => p.configFileName).sort(); }
    finally { snapshot.dispose(); }
  };
  try {
    const first = host.createProgram([entry], {});
    const sibling = host.createProgram([entry], {});
    const siblingSource = sibling.getSourceFile(entry);
    expect(siblingSource).toBeDefined();
    expect(projects()).toEqual([first.project.configFileName, sibling.project.configFileName].sort());
    first.dispose();
    expect(projects()).toEqual([sibling.project.configFileName]);
    expect(sibling.getSourceFile(entry)).toBe(siblingSource);
    expect(sibling.getSourceFile(entry)?.text).toContain("answer");
    expect(sibling.getSemanticDiagnostics()).toEqual([]);

    const next = host.createProgram([entry], {});
    sibling.dispose();
    expect(projects()).toEqual([next.project.configFileName]);
    expect(next.getSemanticDiagnostics()).toEqual([]);
    next.dispose();
    next.dispose(); // teardown may revisit a program; never close twice
    expect(projects()).toEqual([]);
  } finally {
    host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
