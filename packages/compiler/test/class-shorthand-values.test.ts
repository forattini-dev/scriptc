import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

const cases = [
  ["3375-js-error-class-registry.js", "NotFound,NoSuchKey\nNotFound NoSuchKey\ntrue true\nmissing key NoSuchKey true true true\n"],
  ["3376-js-error-class-registry-modules/main.js", "MissingKey\ntrue NoSuchKey\nmissing true true true\n"],
] as const;
const differentialCases: Array<{ backend: "rust" | "llvm" | "c"; file: string; stdout: string }> = (["rust", "llvm", "c"] as const).flatMap(backend => cases.map(([file, stdout]) => ({ backend, file, stdout })));
differentialCases.push(
  { backend: "rust", file: "1940-class-values-basics.ts", stdout: "true false\nAnimal Dog Animal\n3 ... true false\nAnimalia Animalia animals: 2 animals: 1\nwoof ...\ntrue false\nanimals: 7 same\ntruthy\n" },
  { backend: "rust", file: "1941-class-values-registry.ts", stdout: "Triangle triangle 3 true true\nSquare square 4 true false\nShape shape 0 true false\nsquare 4 true\ntriangle true 2\ntrue false true\n1 true 3\n" },
  { backend: "rust", file: "1944-class-values-modules/main.ts", stdout: "true false\nHexagon Shape\nhexagon 6 true true\ngeometry geometry\nHexagon hexagon true\nShape shape false\n" },
);

test.each(differentialCases)("$backend: $file preserves class identity, names and construction", async ({ backend, file, stdout }) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-shorthand-"));
  try {
    const entry = resolve("tests/corpus", file);
    const result = await compile(entry, {
      backend, allowEngine: false, optimization: "dev", outDir: dir, outPath: join(dir, "program"),
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const [node, native] = await Promise.all([
      runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]),
      runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
    ]);
    expect(node.code, node.stderr.toString("utf8")).toBe(0);
    expect(node.signal).toBe(null);
    expect(native.code, native.stderr.toString("utf8")).toBe(node.code);
    expect(native.signal).toBe(null);
    expect(node.stdout.toString("utf8")).toBe(stdout);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  ["runtime-owned.js", "SC3003", "classes extending builtin bases as values"],
  ["generic.ts", "SC2009", "its member 'Box' has type 'typeof Box', which does not compile"],
] as const)("%s retains its named class-value refusal", (file, code, refusal) => {
  const result = analyze(resolve("tests/fixtures/class-shorthand-values", file), { backend: "rust", allowEngine: false });
  expect(result.coverage.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code, message: expect.stringContaining(refusal) }),
  ]));
});
