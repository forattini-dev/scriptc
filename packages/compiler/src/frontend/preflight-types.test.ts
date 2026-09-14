import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { checkPreflight, loadProgram } from "./program.js";
import { checkPreflightTypes } from "./preflight-types.js";
import { CheckerFacade } from "./ts7/checker.js";

test.each([
  { source: 'const value: number = "wrong";', message: "Type 'string' is not assignable to type 'number'." },
  { source: "console.log(missingName);", message: "Cannot find name 'missingName'." },
  { source: "const value = ;", message: "Expression expected." },
  { source: "const value: number = 42; console.log(value);", message: null },
  { source: "const value = JSON.parse('{}'); console.log(value.answer);", message: null },
])("type probes preserve the project verdict for $source", ({ source, message }) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-preflight-types-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const entry = join(dir, "main.ts");
  writeFileSync(entry, source);
  const load = loadProgram(entry);
  const prefetch = vi.spyOn(CheckerFacade.prototype, "prefetchSourceFileStructures");
  try {
    const types = checkPreflightTypes(load);
    expect(prefetch).not.toHaveBeenCalled();
    expect(load.moduleOrder).toEqual([]);
    if (message === null) expect(types).toEqual([]);
    else expect(types).toContainEqual(expect.objectContaining({ code: "SC0001", message }));
    expect(checkPreflight(load).filter((d) => d.code === "SC0001")).toEqual(types);
  } finally {
    prefetch.mockRestore();
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful type probes do not admit external declarations as executable modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-preflight-host-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const entry = join(dir, "main.ts");
  const declaration = join(dir, "host.d.ts");
  writeFileSync(entry, 'import { answer } from "external-host"; console.log(answer);');
  writeFileSync(declaration, "export declare const answer: number;");
  const load = loadProgram(entry, { externalTypes: { "external-host": declaration } });
  try {
    expect(checkPreflightTypes(load)).toEqual([]);
    expect(checkPreflight(load)).toContainEqual(expect.objectContaining({ code: "SC1010" }));
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
