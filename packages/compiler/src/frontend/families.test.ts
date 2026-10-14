import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as ts from "./ts7/adapter.js";
import { isFamilySlotMember } from "./families.js";

test("promise services store generic slots while synchronous class interfaces retain static dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-family-slots-")), entry = join(dir, "main.ts");
  writeFileSync(entry, `
    interface Async { get<T>(value: T): Promise<T>; list<T>(value: T): Promise<T[]> }
    interface Sync { get<T>(value: T): T }
    interface Mixed { get<T>(value: T): T; name: string }
    interface Optional { get?: <T>(value: T) => Promise<T> }
    interface Overloaded { get<T>(value: T): Promise<T>; get<T>(value: T, key: string): Promise<T> }
  `);
  const host = new ts.Ts7Host({ cwd: dir });
  const program = host.createProgram([entry], { strict: true });
  try {
    expect(program.getSemanticDiagnostics()).toEqual([]);
    const sf = program.getSourceFile(entry);
    if (!sf) throw new Error("missing test source");
    const checker = program.getTypeChecker();
    const slots: Record<string, boolean> = {};
    for (const decl of sf.statements.filter(ts.isInterfaceDeclaration)) {
      const type = checker.getTypeAtLocation(decl.name), get = checker.getPropertyOfType(type, "get");
      if (!get) throw new Error("missing generic member");
      slots[decl.name.text] = isFamilySlotMember(checker, type, get);
    }
    expect(slots).toEqual({ Async: true, Sync: false, Mixed: true, Optional: false, Overloaded: false });
  } finally { program.dispose(); host.close(); rmSync(dir, { recursive: true, force: true }); }
});
