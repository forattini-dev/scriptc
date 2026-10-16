import { expect, test } from "vitest";
import { compareMatrices } from "../../scripts/compare-rust-corpus.mjs";
import { makeMatrix } from "../../scripts/rust-corpus-matrix.mjs";

function matrix(names: string[]) {
  return makeMatrix(names, names.map(program => ({ event: "result", program, state: "passed" })),
    names.map(program => ({ program, phase: "build", ok: true, target: "node24", execution: { engine: "none", externalFfi: false } })));
}

test("new passes cannot compensate for a missing protected test", () => {
  const result = compareMatrices(matrix(["old.ts"]), matrix(["new.ts"]));
  expect(result).toMatchObject({ verdict: "FAIL", protectedCount: 1, retained: [],
    regressions: [{ program: "old.ts", reasons: ["absent"] }], added: [{ program: "new.ts", status: "passed-native" }] });
});

test.each(["skipped", "unrun", "failed", "passed-profile-missing"])("a protected test becoming %s fails the checkpoint", status => {
  const next = matrix(["old.ts"]);
  next.rows[0].status = status;
  expect(compareMatrices(matrix(["old.ts"]), next)).toMatchObject({ verdict: "FAIL", regressions: [{ program: "old.ts", reasons: [status] }] });
});

test("native execution, FFI, target and fence properties cannot weaken behind a pass", () => {
  const next = matrix(["old.ts"]);
  Object.assign(next.rows[0], { status: "passed-engine", engine: "v8", externalFfi: true,
    target: "bun", runtimeFences: ["unsupported method"], flaky: true });
  expect(compareMatrices(matrix(["old.ts"]), next)).toMatchObject({ verdict: "FAIL", regressions: [{ reasons:
    ["engine-regression", "external-ffi-regression", "target-changed", "new-runtime-fence", "new-flaky-pass"] }] });
});

test("recovered and added cases are reported separately from retained names", () => {
  const before = matrix(["old.ts", "failing.ts"]);
  before.rows[1].status = "failed";
  const result = compareMatrices(before, matrix(["old.ts", "failing.ts", "new.ts"]));
  expect(result).toMatchObject({ verdict: "PASS", protectedCount: 1, retained: ["old.ts"],
    recovered: ["failing.ts"], added: [{ program: "new.ts", status: "passed-native" }] });
});

test("malformed, duplicate, empty and incomplete baselines cannot establish a green checkpoint", () => {
  expect(() => compareMatrices(matrix(["a.ts", "a.ts"]), matrix(["a.ts"]))).toThrow("duplicate");
  const before = matrix(["a.ts"]);
  before.rows[0].engine = "v8";
  expect(() => compareMatrices(before, matrix(["a.ts"]))).toThrow("native pass without engine none");
  const incomplete = matrix(["a.ts"]); incomplete.complete = false;
  expect(() => compareMatrices(incomplete, matrix(["a.ts"]))).toThrow("incomplete inventory");
  expect(() => compareMatrices(matrix([]), matrix(["a.ts"]))).toThrow("no passing programs");
  const candidate = matrix(["a.ts"]); candidate.complete = false;
  expect(compareMatrices(matrix(["a.ts"]), candidate).verdict).toBe("FAIL");
});
