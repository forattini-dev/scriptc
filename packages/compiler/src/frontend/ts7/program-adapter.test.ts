import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Ts7Host, getPreEmitDiagnostics } from "./program-adapter.js";

test("semantic diagnostics are reused across preflight and later consumers of one snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-ts7-diagnostics-"));
  const entry = join(dir, "entry.ts");
  const other = join(dir, "other.ts");
  writeFileSync(entry, "export function identity(value) { return value; }\n");
  writeFileSync(other, "export const invalid: number = 'text';\n");
  const host = new Ts7Host({ cwd: dir });
  try {
    const strict = host.createProgram([entry, other], { strict: true });
    const query = vi.spyOn(strict.project.program, "getSemanticDiagnostics");
    const preflight = getPreEmitDiagnostics(strict);
    expect(preflight.some((d) => d.code === 7006 && d.fileName === entry)).toBe(true);
    expect(preflight.some((d) => d.code === 2322 && d.fileName === other)).toBe(true);
    const first = strict.getSemanticDiagnostics();
    expect(strict.getSemanticDiagnostics()).toEqual(first);
    expect(query).toHaveBeenCalledTimes(1);

    // A file request has its own scope; the other file's errors stay out.
    const sf = strict.getSourceFile(entry);
    if (sf === undefined) throw new Error("missing entry source file");
    const scoped = strict.getSemanticDiagnostics(sf);
    expect(scoped.some((d) => d.code === 7006)).toBe(true);
    expect(scoped.every((d) => d.fileName === entry)).toBe(true);
    expect(strict.getSemanticDiagnostics(sf)).toEqual(scoped);
    expect(query).toHaveBeenCalledTimes(2);

    // Identical filenames in a sibling snapshot may have different answers.
    const relaxed = host.createProgram([entry, other], { strict: false });
    try {
      expect(relaxed.getSemanticDiagnostics().some((d) => d.code === 7006)).toBe(false);
      expect(relaxed.getSemanticDiagnostics().some((d) => d.code === 2322)).toBe(true);
      expect(strict.getSemanticDiagnostics()).toEqual(first);
      expect(query).toHaveBeenCalledTimes(2);
    } finally { relaxed.dispose(); }
    strict.dispose();
  } finally {
    host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
