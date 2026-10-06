import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../../index.js";

function coverageOf(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-lower-builtins-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return analyze(entry, { backend: "rust", allowEngine: false }).coverage;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const PREDICATES = ["isFinite", "isNaN", "isInteger", "isSafeInteger"] as const;

// The Number statics never coerce: absence answers false and a number answers
// the predicate, whether or not the checker narrowed this use to number.
test.each(PREDICATES)("Number.%s accepts a union holding a number plus null and undefined", (predicate) => {
  const coverage = coverageOf(`
    let stored: number | null | undefined = 1;
    function narrowed(value: number | null | undefined): boolean {
      return value !== null && value !== undefined && Number.${predicate}(value) && value >= 0;
    }
    function whole(value: number | null | undefined): boolean {
      return Number.${predicate}(value);
    }
    function guarded(value: number | null | undefined): boolean {
      return value != null && Number.${predicate}(value);
    }
    function two(value?: number): boolean {
      return Number.${predicate}(value);
    }
    function nullable(value: number | null): boolean {
      return Number.${predicate}(value);
    }
    function nullableNarrowed(value: number | null): boolean {
      return value !== null && Number.${predicate}(value);
    }
    const list: (number | null | undefined)[] = [1, null, undefined];
    console.log(narrowed(1), whole(null), guarded(2), two(), nullable(null), nullableNarrowed(1), Number.${predicate}(stored), Number.${predicate}(list[0]));
  `);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});

test.each([
  ["a number-or-string union", "number | string", '"x"'],
  ["a boolean", "boolean", "true"],
])("Number statics keep their refusal for %s", (_name, type, sample) => {
  const coverage = coverageOf(`
    function check(value: ${type}): boolean { return Number.isInteger(value); }
    console.log(check(${sample}));
  `);
  const refusals = coverage.diagnostics.filter((d) => d.code === "SC2020");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]!.message).toContain("Number.isInteger of '");
});

// A checker-narrowed Buffer that is still stored in a union with null and
// undefined reaches the decoder through the checked arm, as the two-arm form
// already did.
test.each([
  "Buffer | undefined",
  "Buffer | null | undefined",
  "Uint8Array | null | undefined",
])("StringDecoder.write accepts a narrowed %s", (type) => {
  const coverage = coverageOf(`
    import { StringDecoder } from "node:string_decoder";
    const decoder = new StringDecoder("utf8");
    function feed(chunk: ${type}): string {
      if (chunk != null) return decoder.write(chunk);
      return "-";
    }
    console.log(feed(Buffer.from("héllo")), feed(undefined));
  `);
  expect(coverage.preflightFailed).toBe(false);
  expect(coverage.diagnostics).toEqual([]);
  expect(coverage.stats.statementsFailed).toBe(0);
});
