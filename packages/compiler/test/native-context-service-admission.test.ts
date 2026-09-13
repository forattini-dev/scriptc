import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function analyzeSource(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-context-service-"));
  try {
    symlinkSync(resolve(import.meta.dirname, "../../../node_modules"), join(dir, "node_modules"), "dir");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source + "\nexport {};\n");
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.runtimeFences ?? []).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("generic Context.Service parameters and namespace import aliases retain use provenance", () => {
  analyzeSource(`import { Context as Ctx, Effect } from 'effect';
function access<I, S>(tag: Ctx.Service<I, S>, read: (service: S) => Effect.Effect<number>) {
  return tag.use(read);
}
class Value extends Ctx.Service<Value, { amount: number }>()('value') {}
const program = access(Value, service => Effect.succeed(service.amount));
console.log(Effect.runSync(Effect.provideService(program, Value, { amount: 7 })));
`);
});

test("a user class method named use retains its own implementation", () => {
  analyzeSource(`class Service {
  use(read: (value: number) => number): number { return read(7) + 1; }
}
console.log(new Service().use(value => value * 2));`);
});
