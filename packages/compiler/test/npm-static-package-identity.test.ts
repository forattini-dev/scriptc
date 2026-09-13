import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([
  ["auto", "fixture", "fixture"],
  ["auto", "@fixture/value", "fixture__value"],
  ["lib", "fixture", "fixture"],
  ["lib", "@fixture/value", "fixture__value"],
] as const)("npm %s attributes third-party declarations to runtime package %s", (mode, name, typesName) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-npm-identity-"));
  const runtime = join(directory, "node_modules", name);
  const declarations = join(directory, "node_modules", "@types", typesName);
  try {
    mkdirSync(runtime, { recursive: true });
    mkdirSync(declarations, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(runtime, "index.js"), "export const answer = 42;\n");
    writeFileSync(join(declarations, "package.json"), JSON.stringify({ name: `@types/${typesName}`, types: "index.d.ts" }));
    writeFileSync(join(declarations, "index.d.ts"), "export declare const answer: number;\n");
    const entry = join(directory, "main.ts");
    writeFileSync(entry, `import { answer } from ${JSON.stringify(name)}; console.log(answer);\n`);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false, npmStatic: mode });
    expect(coverage.npmStatic).toEqual([{
      package: name,
      status: "fallback",
      detail: `${mode === "auto" ? "auto: " : ""}third-party declarations require valid stable runtime and @types versions`,
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
