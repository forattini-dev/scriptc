import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { analyze } from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.each(["preserve", "react", "react-native", "react-jsx", "react-jsxdev"])(
  "adopts inherited jsx=%s for a project with no JSX expressions",
  (jsx) => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-jsx-config-"));
    directories.push(dir);
    writeFileSync(join(dir, "base.json"), JSON.stringify({ compilerOptions: { strict: true, jsx } }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
    const entry = join(dir, "main.ts");
    writeFileSync(entry, 'console.log("native");\n');
    const { coverage } = analyze(entry);
    expect(coverage.preflightFailed, JSON.stringify(coverage.diagnostics)).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
  },
);
