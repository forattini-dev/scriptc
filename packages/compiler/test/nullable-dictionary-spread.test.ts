import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test.each([true, false])("Rust admits nullable dictionary reads and open record-array spreads with unchecked=%s", noUncheckedIndexedAccess => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-nullable-spread-"));
  try {
    const entry = join(root, "main.ts");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      strict: true, noUncheckedIndexedAccess, target: "ES2022", types: [],
    }, files: ["main.ts"] }));
    writeFileSync(entry, `
      type Row = { bindings?: Record<string, string | null> } & Record<string, unknown>;
      type Config = { rows?: Row[] } & Record<string, unknown>;
      function update(config: Config, key: string): Config {
        const rows = config.rows ?? [];
        const next = rows.map(row => {
          const bindings = row.bindings ?? {};
          const value = bindings[key];
          console.log(value === null, value === undefined, value ?? "absent");
          return { ...row, bindings: { ...bindings, [key]: null } };
        });
        return { ...config, rows: next };
      }
      function append(config: Config): Config {
        const rows = config.rows;
        if (!Array.isArray(rows)) return { ...config, rows: [{}] };
        const entry = rows.find(row => typeof row === "object" && row !== null);
        if (!entry) return { ...config, rows: [...rows, {}] };
        return config;
      }
      console.log(JSON.stringify(update(JSON.parse('{"rows":[{"bindings":{"a":null}}],"extra":1}') as Config, "a")));
      console.log(JSON.stringify(append({ rows: [] })));
    `);
    const coverage = analyze(entry, { backend: "rust", allowEngine: false }).coverage;
    expect(coverage.preflightFailed, JSON.stringify(coverage)).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.execution?.engine).toBe("none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
