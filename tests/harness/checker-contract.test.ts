import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { compareCheckerContracts, validateCheckerMatrix } from "../../scripts/checker-contract.mjs";

test("checker comparison protects every named observation at one upstream pin", () => {
  const upstream = "a".repeat(40);
  const baseline = { name: "go", upstream, ok: true, cases: { narrowing: "string", tuple: [0, 2] } };
  expect(compareCheckerContracts([baseline, { ...baseline, name: "rust" }]).verdict).toBe("PASS");
  const missing = compareCheckerContracts([baseline, { ...baseline, name: "rust", cases: { narrowing: "string" } }]);
  expect(missing).toMatchObject({ verdict: "FAIL", failures: [{ checker: "rust", case: "tuple" }] });
  expect(() => compareCheckerContracts([baseline, { ...baseline, name: "rust", upstream: "b".repeat(40) }])).toThrow("different upstream pins");
  expect(() => compareCheckerContracts([baseline, baseline])).toThrow("duplicate checker result");
  expect(compareCheckerContracts([{ ...baseline, cases: {} }]).verdict).toBe("FAIL");
});

test("a crashed reference or candidate cannot become parity through an empty answer", () => {
  const baseline = { name: "go", upstream: "a".repeat(40), ok: true, cases: { value: 1 } };
  expect(compareCheckerContracts([baseline, { name: "rust", ok: false, error: "timeout" }])).toMatchObject({
    verdict: "FAIL", failures: [{ checker: "rust", reason: "timeout" }],
  });
  expect(compareCheckerContracts([{ name: "go", ok: false, error: "crash" }, { ...baseline, name: "rust" }]).verdict).toBe("FAIL");
});

test("checker matrices pin client revisions and verify server bytes before execution", () => {
  const root = mkdtempSync(join(tmpdir(), "scriptc-checker-matrix-"));
  try {
    const upstream = "a".repeat(40);
    mkdirSync(join(root, "client"));
    writeFileSync(join(root, "client/package.json"), JSON.stringify({ version: "fixture", gitHead: upstream }));
    writeFileSync(join(root, "server"), "fixture server");
    const entry = { name: "rust", client: "client", server: "server", mode: "direct",
      sha256: createHash("sha256").update("fixture server").digest("hex") };
    const matrix = { schemaVersion: 1, upstream, checkers: [entry] };
    expect(validateCheckerMatrix(matrix, root)[0]).toMatchObject({ client: join(root, "client"), server: join(root, "server"), upstream });
    expect(() => validateCheckerMatrix({ ...matrix, upstream: "b".repeat(40) }, root)).toThrow("client pin mismatch");
    expect(() => validateCheckerMatrix({ ...matrix, checkers: [entry, entry] }, root)).toThrow("duplicate checker name");
    writeFileSync(join(root, "server"), "changed bytes");
    expect(() => validateCheckerMatrix(matrix, root)).toThrow("server hash mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
