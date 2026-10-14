import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadProgram } from "./program.js";
import * as ts from "./ts7/adapter.js";
import { uninhabitedIntersection } from "./intersection-inhabitation.js";

test("proves conflicting required discriminants but preserves optional and wider intersections", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-intersection-"));
  const entry = join(directory, "entry.ts");
  writeFileSync(entry, `type Conflict = { kind: "a" } & { kind: "b" };
type Optional = { kind?: "a" } & { kind?: "b" };
type Refined = { kind: string; value: number } & { kind: "b" };
type Overlap = { kind: "a" | "b" } & { kind: "b" | "c" };
type Required = { kind?: "a" } & { kind: "b" };`);
  const load = loadProgram(entry);
  try {
    const checker = load.program.getTypeChecker();
    const answers = new Map<string, boolean>();
    for (const statement of load.entry.statements) {
      if (ts.isTypeAliasDeclaration(statement)) answers.set(statement.name.text, uninhabitedIntersection(checker.getTypeAtLocation(statement.name), checker));
    }
    expect(Object.fromEntries(answers)).toEqual({ Conflict: true, Optional: false, Refined: false, Overlap: false, Required: true });
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
