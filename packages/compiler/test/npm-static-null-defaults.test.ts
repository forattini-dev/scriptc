import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runFileStdio } from "../../../tests/harness/file-stdio.js";
import { primaryOracleExecutable } from "../../../tests/harness/node-matrix.js";
import { analyze, compile, NODE_COMPAT_MATRIX } from "../src/index.js";

const consumers = [
  { entry: "tests/fixtures/npm-static/null-default-cli.ts", npmStatic: "auto" as const },
  { entry: "tests/corpus/3392-js-null-default-pattern.js", npmStatic: undefined },
].flatMap((consumer) => (["dev", "release"] as const).map((optimization) => ({ ...consumer, optimization })));

test.each(consumers)("null-default object parameters preserve values in $entry ($optimization)", async ({ entry: entryPath, npmStatic, optimization }) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-null-default-"));
  try {
    const entry = resolve(entryPath);
    const node = await runFileStdio(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry]);
    expect(node.code).toBe(0);
    expect(node.stdout.toString("utf8")).toBe("explicit 1\ngenerated 2\ngenerated 3\ngenerated 4\n");
    expect(node.stderr.toString("utf8")).toBe("");
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, npmStatic, optimization,
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const native = await runFileStdio(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
    expect(native.code, native.stderr.toString("utf8")).toBe(node.code);
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  ["declaration input errors", "", "number", 'new Client({ id: "wrong", payload: 1 });', true],
  ["unrelated TypeScript errors", "", "string", 'const broken: number = "wrong"; new Client({ id: "ok", payload: 1 });', true],
  ["explicit JavaScript contracts", "/** @param {{id?: null, payload: number}} options */", "string", 'new Client({ id: "declared", payload: 1 });', false],
])("null-default admission does not erase %s", async (_name, comment, declaredId, source, authoringError) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-null-default-boundary-"));
  try {
    const pkg = join(directory, "node_modules", "null-default");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    await writeFile(join(pkg, "package.json"), '{"name":"null-default","type":"module","main":"index.js","types":"index.d.ts"}\n');
    await writeFile(join(pkg, "index.js"), `export class Client {\n  ${comment}\n  constructor({ id = null, payload }) { console.log(id, payload); }\n}\n`);
    await writeFile(join(pkg, "index.d.ts"), `export declare class Client { constructor(options: { id?: ${declaredId} | null; payload: unknown }); }\n`);
    const entry = join(directory, "main.ts");
    await writeFile(entry, 'import { Client } from "null-default";\n' + source);
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false, npmStatic: "auto" });
    if (authoringError) {
      expect(coverage.preflightFailed).toBe(true);
      expect(coverage.diagnostics).toContainEqual(expect.objectContaining({ code: "SC0001" }));
    } else {
      expect(coverage.npmStatic).toContainEqual(expect.objectContaining({ package: "null-default", status: "fallback" }));
      expect(coverage.diagnostics).toContainEqual(expect.objectContaining({ code: "SC2013" }));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
