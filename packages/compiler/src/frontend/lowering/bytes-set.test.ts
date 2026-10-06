import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../../index.js";

function coverageOf(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-bytes-set-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const program = (body: string) => `
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;
  const list: number[] = [1, 2, 3];
  const frozen: readonly number[] = [4, 5];
  const out = new Uint8Array(12);
  const wide = new Float64Array(4);
  const buffer = Buffer.alloc(8);
  const other = new Uint8Array(2);
  function numbers(): number[] { return [7, 8]; }
  ${body}
  console.log(out.join(","), wide[0], wide[1], buffer.toString("hex"));
`;

// Numeric tuples, number[] values and array literals copy element by element;
// the live set lowering must reach that path, not only the same-kind one.
test.each([
  "out.set(SIGNATURE, 0)",
  "out.set(SIGNATURE)",
  "out.set(list, 1)",
  "out.set(frozen, 2)",
  "out.set(numbers(), 3)",
  "out.set([1, 2, 3], 4)",
  "out.set([...list, 9], 4)",
  "out.set([], 12)",
  "wide.set([1.5, -2.5], 1)",
  "wide.set(SIGNATURE)",
  "buffer.set([104, 105], 1)",
  "out.subarray(2, 6).set(SIGNATURE)",
  "out.set(other, 1)",
])("TypedArray.set lowers natively: %s", (statement) => {
  const coverage = coverageOf(program(statement));
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test("a different typed-array kind still has no lowering and the hint names the supported sources", () => {
  const coverage = coverageOf(program("out.set(new Int32Array(2), 1)"));
  const refusals = coverage.diagnostics.filter((d) => d.code === "SC2020");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]!.message).toContain(".set from 'Int32Array");
});
