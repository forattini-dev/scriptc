import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { Ts7Host, getPreEmitDiagnostics } from "./program-adapter.js";

test.each(["owned", "shared"])("discarded %s-host programs release materialized ASTs and checker facades", async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-ts7-retention-"));
  const runner = join(dir, "probe.mjs");
  const entry = join(dir, "entry.ts");
  const sibling = join(dir, "sibling.ts");
  writeFileSync(entry, "export const answer = 42;\n");
  writeFileSync(sibling, "export const sibling = 'still alive';\n");
  // A fresh process gives the real TS7 client a deterministic GC boundary.
  // Keeping the disposed wrapper alive models the npm attribution loop,
  // which retains its previous load while probing candidate package sets.
  writeFileSync(runner, `
    import { strict as assert } from "node:assert";
    import { setImmediate } from "node:timers/promises";
    import { createProgram, Ts7Host } from ${JSON.stringify(new URL("./program-adapter.ts", import.meta.url).href)};
    const host = process.argv[2] === "shared" ? new Ts7Host({ cwd: ${JSON.stringify(dir)} }) : undefined;
    function prepare() {
      const program = createProgram([${JSON.stringify(entry)}], { noLib: true }, host);
      const file = program.getSourceFiles().find(file => file.fileName === ${JSON.stringify(entry)});
      assert.ok(file);
      const checker = program.getTypeChecker();
      checker.getTypeAtLocation(file.statements[0]);
      const references = [new WeakRef(file), new WeakRef(checker)];
      program.dispose();
      return { program, references };
    }
    try {
      const retained = prepare();
      for (let i = 0; i < 12; i++) { await setImmediate(); globalThis.gc(); }
      assert.equal(retained.references[0].deref() === undefined, true, "disposed program retains its AST");
      assert.equal(retained.references[1].deref() === undefined, true, "disposed program retains its checker facade");
      retained.program.dispose(); // idempotent; keep the wrapper alive through the checks
      if (host) {
        const next = host.createProgram([${JSON.stringify(sibling)}], { noLib: true });
        assert.ok(next.getSourceFile(${JSON.stringify(sibling)}));
        next.dispose();
      }
      process.stdout.write("released\\n");
    } finally { host?.close(); }
  `);
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ["--expose-gc", "--import", "tsx", runner, mode],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(stdout).toBe("released\n");
    expect(stderr).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
