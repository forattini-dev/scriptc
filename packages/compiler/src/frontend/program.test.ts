import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { API } from "typescript/unstable/sync";
import { loadProgram, checkPreflight } from "./program.js";

test("preflight releases its temporary project type world before continuing", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-preflight-lifecycle-"));
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, "const data = JSON.parse('{}'); console.log(data.value);\n");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const load = loadProgram(entry);
  const api: API = Reflect.get(Reflect.get(load.program, "host"), "api");
  const projects = (): string[] => {
    const snapshot = api.updateSnapshot({});
    try { return snapshot.getProjects().map((p) => p.configFileName); }
    finally { snapshot.dispose(); }
  };
  try {
    // The override makes JSON.parse unknown; the author's world has no error.
    expect(load.program.getSemanticDiagnostics().some((d) => d.code === 18046)).toBe(true);
    expect(checkPreflight(load)).toEqual([]);
    expect(projects()).toEqual([load.program.project.configFileName]);
    expect(() => load.withProjectWorld(() => { throw new Error("callback failed"); })).toThrow("callback failed");
    expect(projects()).toEqual([load.program.project.configFileName]);
    // A second preflight must not reuse an already-disposed temporary world.
    expect(checkPreflight(load)).toEqual([]);
    expect(projects()).toEqual([load.program.project.configFileName]);
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
