import { resolve } from "node:path";
import { expect, test } from "vitest";
import { serializeModule } from "../../ir/serialize.js";
import { loadProgram } from "../program.js";
import { lowerToIr } from "./lowerer.js";

const UNREACHED_FENCE = resolve("tests/coverage-fixtures/js-unreached-fence.js");
const REACHED_FENCE = resolve("tests/coverage-fixtures/js-builtin-callable-alias.js");

test("coverage lowering keeps the unreached remainder's deferred fences", () => {
  // The entry path is clean; the never-called function's fences would be
  // dropped with the throwaway pass without this field.
  const load = loadProgram(UNREACHED_FENCE);
  try {
    const result = lowerToIr(load.program, load.entry, load.moduleOrder, { coverage: true });
    expect(result.diagnostics).toEqual([]);
    expect(result.runtimeFences).toEqual([]);
    expect(result.module).not.toBeNull();
    const unreached = result.unreached!;
    expect(unreached.diagnostics).toEqual([]);
    expect(unreached.runtimeFences.map((d) => d.code)).toEqual(["SC1090", "SC2004"]);
    expect(unreached.runtimeFences.every((d) => d.loc.file === UNREACHED_FENCE)).toBe(true);
    expect(unreached.stats).toEqual({ statementsTotal: 2, statementsFailed: 2, statementsIsland: 0, functionsSkipped: 0 });
  } finally {
    load.dispose();
  }
});

test("the coverage remainder never changes the build's own lowering result", () => {
  for (const entry of [UNREACHED_FENCE, REACHED_FENCE]) {
    const load = loadProgram(entry);
    try {
      const build = lowerToIr(load.program, load.entry, load.moduleOrder);
      const coverage = lowerToIr(load.program, load.entry, load.moduleOrder, { coverage: true });
      expect(build.unreached).toBeUndefined();
      expect(coverage.diagnostics).toEqual(build.diagnostics);
      expect(coverage.runtimeFences).toEqual(build.runtimeFences);
      expect(coverage.stats).toEqual(build.stats);
      expect(coverage.module === null).toBe(build.module === null);
      if (build.module !== null && coverage.module !== null) {
        expect(serializeModule(coverage.module)).toBe(serializeModule(build.module));
      }
    } finally {
      load.dispose();
    }
  }
});
