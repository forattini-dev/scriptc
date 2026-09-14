import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { API } from "typescript/unstable/sync";
import { loadProgram, checkPreflight } from "./program.js";

test("static JS source discovery crosses deep and shared declaration paths without truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-static-depth-"));
  const entry = join(dir, "entry.ts");
  try {
    for (const [name, next] of Object.entries({ short: "shared", long: "extra", extra: "middle", middle: "shared", shared: "leaf" })) {
      const pkg = join(dir, "node_modules", name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, types: "index.d.ts" }));
      writeFileSync(join(pkg, "index.d.ts"), `import "${next}"; export {};`);
    }
    const leaf = join(dir, "node_modules", "leaf");
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, "package.json"), JSON.stringify({ name: "leaf", main: "index.js" }));
    writeFileSync(join(leaf, "index.js"), 'exports.value = require("./child.js").value;');
    // Cycles must terminate by file identity, not by a depth cutoff.
    writeFileSync(join(leaf, "child.js"), 'exports.value = 42; require("./index.js");');
    for (const source of ['import "long";', 'import "short"; import "long";', 'import "long"; import "short";']) {
      writeFileSync(entry, source);
      const load = loadProgram(entry, { npmStatic: ["leaf"] });
      try {
        expect(load.program.getSourceFileNames()).toEqual(expect.arrayContaining([
          join(leaf, "index.js"), join(leaf, "child.js"),
        ]));
      } finally { load.dispose(); }
    }
    const flagless = loadProgram(entry);
    try {
      expect(flagless.program.getSourceFileNames()).not.toContain(join(leaf, "index.js"));
    } finally { flagless.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
