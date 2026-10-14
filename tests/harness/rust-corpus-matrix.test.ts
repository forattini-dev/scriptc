import { expect, test } from "vitest";
import { classifyProgram, makeMatrix } from "../../scripts/rust-corpus-matrix.mjs";

test("parity and actual engine profile are both required for native or engine passes", () => {
  const build = (engine: string) => [{ phase: "build", ok: true, execution: { engine, externalFfi: false } }];
  expect(classifyProgram("a", { state: "passed" }, build("none")).status).toBe("passed-native");
  expect(classifyProgram("a", { state: "passed" }, build("v8")).status).toBe("passed-engine");
  expect(classifyProgram("a", undefined, build("none")).status).toBe("unrun");
  expect(classifyProgram("a", { state: "passed" }, []).status).toBe("passed-profile-missing");
});

test("refusals, missing tools, parity mismatches and unavailable oracles stay distinct", () => {
  const failed = { state: "failed", errors: [] };
  expect(classifyProgram("a", failed, [{ phase: "build", ok: false, diagnostics: [{ code: "SC3001" }] }]).failureKind).toBe("rust-refusal");
  expect(classifyProgram("a", { ...failed, errors: [{ message: "spawn rustc ENOENT" }] }).failureKind).toBe("environment-tool-missing");
  expect(classifyProgram("a", failed, [{ phase: "execution", stdoutEqual: false }]).failureKind).toBe("stdout-mismatch");
  expect(classifyProgram("a", { ...failed, errors: [{ message: "expected ENOENT but got ENOSYS" }] },
    [{ phase: "execution", stdoutEqual: false }]).failureKind).toBe("stdout-mismatch");
  expect(classifyProgram("a", { state: "skipped", note: "no bun" }).skipReason).toBe("no bun");
});

test("the inventory remains the denominator and duplicate final verdicts are rejected", () => {
  const verdict = { event: "result", program: "a", state: "passed" };
  const matrix = makeMatrix(["a", "b"], [verdict], []);
  expect(matrix.inventoryCount).toBe(2);
  expect(matrix.complete).toBe(false);
  expect(matrix.counts.unrun).toBe(1);
  expect(() => makeMatrix(["a"], [verdict, verdict], [])).toThrow("duplicate final verdict");
});

test("a final timeout is not hidden by evidence left by an earlier attempt", () => {
  expect(classifyProgram("a", { state: "failed", errors: [{ message: "Test timed out in 300000ms.\nIf this is a long-running test..." }] }, [
    { phase: "build", ok: true, execution: { engine: "none" } },
    { phase: "execution", stdoutEqual: true, stderrEqual: true, expectedExit: 0, rustExit: 0, nodeExit: 0 },
  ]).failureKind).toBe("timeout");
});

test("process containment intervention cannot count as successful parity", () => {
  expect(classifyProgram("a", { state: "failed", errors: [{ message: "Windows job resource boundary: rust left descendants" }] }, [
    { phase: "execution", stdoutEqual: true, stderrEqual: true, expectedExit: 0, rustExit: 0, nodeExit: 0 },
  ]).failureKind).toBe("resource-boundary");
});

test("a successful retry uses the latest build profile and preserves the flaky verdict", () => {
  const result = makeMatrix(["a"], [{ event: "result", program: "a", state: "passed", diagnostic: { retryCount: 1, flaky: true } }], [
    { program: "a", phase: "build", ok: false, diagnostics: [{ code: "SC3001" }] },
    { program: "a", phase: "build", ok: true, execution: { engine: "none", externalFfi: false } },
  ]);
  expect(result.complete).toBe(true);
  expect(result.rows[0]).toMatchObject({ status: "passed-native", retried: true, flaky: true, diagnostics: [] });
});
