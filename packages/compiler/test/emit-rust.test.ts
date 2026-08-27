import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { compileRust } from "../src/backend/rust/compile.js";
import { emitRustModule } from "../src/backend/rust/emitter.js";
import { validateModule } from "../src/ir/validate.js";
import { fibModule } from "./fixtures/fib-ir.js";

const execFileAsync = promisify(execFile);

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runToExit(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessOutcome> {
  return new Promise((resolveRun) => {
    execFile(file, args, { encoding: "utf8", env }, (error, stdout, stderr) => {
      resolveRun({
        stdout,
        stderr,
        exitCode: error && typeof error.code === "number" ? error.code : 0,
      });
    });
  });
}

async function nodeCorpusArgs(entryPath: string): Promise<string[]> {
  const source = await readFile(entryPath, "utf8");
  const sources = [source];
  if (/[/\\]main\.(?:ts|js|mjs|cjs)$/u.test(entryPath)) {
    const pending = [dirname(entryPath)];
    while (pending.length !== 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (path !== entryPath && [".ts", ".js", ".mjs", ".cjs"].includes(extname(path))) {
          sources.push(await readFile(path, "utf8"));
        }
      }
    }
  }
  const transform = source.split("\n", 2).some((line) => /^\/\/ @transform-types\s*$/u.test(line)) ||
    sources.some((input) => /\benum\s+[A-Za-z_$]/u.test(input));
  return transform
    ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", entryPath]
    : [entryPath];
}

test("Rust emitter compiles recursive scalar IR without unsafe or C", async () => {
  expect(validateModule(fibModule)).toEqual([]);
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-emit-"));
  const sourcePath = join(dir, "fib.rs");
  const outPath = join(dir, "fib");
  const source = emitRustModule(fibModule);
  expect(source).toContain("#![forbid(unsafe_code)]");
  expect(source).not.toMatch(/extern\s+"C"|\.c\b/);
  await writeFile(sourcePath, source);
  await compileRust({ sourcePath, outPath, optimization: "dev" });
  const { stdout } = await execFileAsync(outPath);
  expect(stdout).toBe("55\n");
}, 120_000);

test("TypeScript lowers through the Rust backend to a rustc executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-pipeline-"));
  const outPath = join(dir, "hello");
  const result = await compile(resolve("tests/corpus/001-hello.ts"), {
    outDir: dir,
    outPath,
    backend: "rust",
    emitIr: true,
    optimization: "dev",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.backend).toBe("rust");
  if (result.backend !== "rust") return;
  expect(result.safetyProfile).toBe("rust-only");
  expect(result.sourcePath.endsWith(".rs")).toBe(true);
  expect(result.cPath).toBe(result.sourcePath);
  expect(await readFile(result.sourcePath, "utf8")).toContain("#![forbid(unsafe_code)]");
  const { stdout } = await execFileAsync(result.binaryPath);
  expect(stdout).toBe("hello world\n");
}, 120_000);

test("Rust typed JSON parse/stringify matches Node for scalars, arrays, records, unions, optionals, and cycles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-json-scalars-"));
  const entryPath = join(dir, "json-scalars.ts");
  await writeFile(entryPath, `
console.log(JSON.stringify(1), JSON.stringify(1.5), JSON.stringify(-2.25));
console.log(JSON.stringify(true), JSON.stringify(false));
console.log(JSON.stringify(0 / 0), JSON.stringify(1 / 0), JSON.stringify(-1 / 0), JSON.stringify(-0));
console.log(JSON.stringify(1e21), JSON.stringify(1e-7), JSON.stringify(0.1 + 0.2));
console.log(JSON.stringify('quote " backslash \\\\ slash /'));
console.log(JSON.stringify("line\\nbreak\\ttab\\rret\\u0007"));
console.log(JSON.stringify("héllo 日本語 😀"));
const nums: number[] = [1, 2.5, -0, 0 / 0];
console.log(JSON.stringify(nums), JSON.stringify([[1, 2], [], [3]]));
const point = { y: -1.5, label: "origin", x: 0 };
const cfg = { debug: true, ports: [80, 443], server: { host: "example.com", port: 8080 } };
console.log(JSON.stringify(point));
console.log(JSON.stringify(cfg));
type Optional = { name: string; count?: number };
const absent: Optional = { name: "absent" };
const present: Optional = { name: "present", count: 2 };
console.log(JSON.stringify(absent), JSON.stringify(present));
type Link = { value: number; next: Link | null };
const link: Link = { value: 1, next: null };
link.next = link;
try { console.log(JSON.stringify(link)); }
catch { console.log("cycle"); }
try { console.log(JSON.parse("{") as number); }
catch { console.log("syntax"); }
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "json-scalars"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
  for (const fixture of [
    "1000-json-stringify-basics.ts",
    "1001-json-escapes-unicode.ts",
    "1003-json-parse-unions.ts",
    "1008-json-null-arms.ts",
    "1009-json-optional-fields.ts",
    "541-ref-array-json.ts",
  ]) {
    const corpusPath = resolve("tests/corpus", fixture);
    const corpusResult = await compile(corpusPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      corpusResult.ok,
      corpusResult.ok ? fixture : `${fixture}: ${corpusResult.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!corpusResult.ok) continue;
    const [corpusNode, corpusRust] = await Promise.all([
      execFileAsync(process.execPath, [corpusPath]),
      execFileAsync(corpusResult.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(corpusRust.stdout, fixture).toBe(corpusNode.stdout);
    expect(corpusRust.stderr, fixture).toBe(corpusNode.stderr);
  }
}, 120_000);

test("Rust UTF-16 string methods, array iteration, record arrays, and tuples match Node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-builtins-"));
  for (const fixture of [
    "210-string-methods.ts",
    "211-string-unicode.ts",
    "502-array-for-of.ts",
    "512-array-join-chains.ts",
    "530-record-arrays.ts",
    "540-tuples-basics.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    if (name === "promise-reject") {
      expect((await readFile(result.sourcePath)).length).toBeLessThan(200_000);
    }
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 120_000);

test("Rust string.at keeps the documented catchable out-of-range divergence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-string-at-"));
  const entryPath = join(dir, "at-out-of-range.ts");
  await writeFile(entryPath, `
const value = "abc";
try {
  console.log(value.at(99));
  console.log("unreachable");
} catch { console.log("caught"); }
console.log(value.at(-1));
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "at-out-of-range"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; ")).toBe(true);
  if (!result.ok) return;
  const rust = await runToExit(result.binaryPath, [], {
    ...process.env,
    SCRIPTC_RUST_HEAP_AUDIT: "1",
  });
  expect(rust).toEqual({
    stdout: "caught\nc\n",
    stderr: "",
    exitCode: 0,
  });
}, 120_000);

test("Rust array higher-order methods preserve callbacks, references, reductions, and sorting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-array-hofs-"));
  for (const fixture of [
    "503-array-functions.ts",
    "510-array-map-filter-foreach.ts",
    "513-array-methods-rc-stress.ts",
    "514-array-find-some-every.ts",
    "515-array-flatmap.ts",
    "516-array-reduce.ts",
    "517-array-hof-index-args.ts",
    "518-array-sort.ts",
    "2685-array-unshift-reverse.ts",
    "531-record-array-hofs.ts",
    "532-record-arrays-rc-stress.ts",
    "533-array-element-cycles.ts",
    "534-record-width-subtyping.ts",
    "542-union-element-arrays.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 120_000);

test("constant-folded standalone class instanceof preserves JavaScript results in Rust", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-class-instanceof-"));
  const entryPath = join(dir, "instanceof.ts");
  await writeFile(entryPath, `
class Token { value: number = 1; }
class Other {}
const token = new Token();
console.log(token instanceof Token, token instanceof Other, token.value);
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "instanceof"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; ")).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 120_000);

test("class field increment and decrement preserve value and receiver evaluation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-class-incdec-"));
  const entryPath = join(dir, "field-incdec.ts");
  await writeFile(entryPath, `
class Counter {
  value: number = 1;
  postIncrement(): number { return this.value++; }
  preIncrement(): number { return ++this.value; }
}
const counter = new Counter();
let receiverCalls = 0;
function receiver(): Counter {
  receiverCalls++;
  return counter;
}
console.log(counter.postIncrement(), counter.value);
console.log(counter.preIncrement(), counter.value);
console.log(receiver().value++, ++receiver().value, counter.value, receiverCalls);
console.log(counter.value--, --counter.value, counter.value);
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "field-incdec"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; ")).toBe(true);
  if (!result.ok || result.backend !== "rust") return;
  expect(await readFile(result.sourcePath, "utf8")).toContain("with_mut(|object|");
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 120_000);

test("generated record and array cycles are collected by the safe Rust heap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-cycles-"));
  const entryPath = join(dir, "cycles.ts");
  await writeFile(entryPath, `
interface Link { name: string; edges: Link[] }
function cycle(i: number): number {
  const a: Link = { name: "a" + i, edges: [] };
  const b: Link = { name: "b" + i, edges: [] };
  a.edges.push(b);
  b.edges.push(a);
  a.name = "left";
  return a.edges.length + b.edges.length + a.name.length;
}
console.log(cycle(0));
for (let i = 0; i < 100; i++) cycle(i);
const self: Link = { name: "self", edges: [] };
self.edges.push(self);
console.log(self.edges.length);
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "cycles"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; ")).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 120_000);

test("Rust enums narrow scalar union arms and preserve strict equality", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-unions-"));
  const entryPath = join(dir, "unions.ts");
  await writeFile(entryPath, `
function show(value: string | number | boolean | undefined): string {
  if (value === undefined) return "u";
  if (typeof value === "string") return "s:" + value;
  if (typeof value === "number") return "n:" + value;
  return value ? "true" : "false";
}
function sameValue(left: number | undefined, right: number | undefined): boolean {
  return Object.is(left, right);
}
type Result = { kind: "ok"; value: number } | { kind: "err"; message: string };
function render(result: Result): string {
  if (result.kind === "ok") return "ok:" + result.value;
  return "err:" + result.message;
}
console.log(show(undefined), show("x"), show(2), show(false));
console.log(render({ kind: "ok", value: 42 }), render({ kind: "err", message: "boom" }));
const nanLeft: number | undefined = 0 / 0;
const nanRight: number | undefined = 0 / 0;
const positiveZero: number | undefined = 0;
const negativeZero: number | undefined = -0;
console.log(nanLeft === nanRight, sameValue(nanLeft, nanRight));
console.log(positiveZero === negativeZero, sameValue(positiveZero, negativeZero));
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "unions"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; ")).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 120_000);

test("captured function bindings form collectable cycles in safe Rust", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-closure-cycles-"));
  const entryPath = join(dir, "closure-cycles.ts");
  await writeFile(entryPath, `
function makeCycle(): void {
  let fn = () => 0;
  fn = () => fn();
}
for (let i = 0; i < 100; i++) makeCycle();
console.log("cycles released");
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "closure-cycles"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; ")).toBe(true);
  if (!result.ok || result.backend !== "rust") return;
  const generated = await readFile(result.sourcePath, "utf8");
  expect(generated).toContain("#![forbid(unsafe_code)]");
  expect(generated).toContain("runtime::JsCell<runtime::Gc<sc_closure_");
  expect(generated).not.toContain("extern \"C\"");
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 120_000);

test("typed throws and abrupt completions cross try/catch/finally safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-completions-"));
  const entryPath = join(dir, "completions.ts");
  await writeFile(entryPath, `
interface Fault { label: string }
function hurl(kind: number): void {
  if (kind === 0) throw { label: "record" } as Fault;
  if (kind === 1) throw ["array"];
  throw () => "closure";
}
for (let kind = 0; kind < 3; kind++) {
  try { hurl(kind); } catch { console.log("caught", kind); }
}
try { throw "plain"; }
catch (error) { console.log("is Error", error instanceof Error); }
class LocalError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "LocalError";
    this.code = code;
  }
}
const localError = new LocalError("local failure", 17);
console.log("local error", localError instanceof Error, localError.toString(), localError.code);
try { throw localError; }
catch (error) {
  if (error instanceof LocalError) console.log("local catch", error.message, error.code);
}
function scan(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    try {
      if (i === 1) continue;
      if (i === 2) throw "two";
      if (i === 5) break;
      out = out + i;
    } catch {
      out = out + "C";
      continue;
    }
    out = out + ".";
  }
  return out;
}
function snapshot(): number {
  let value = 1;
  try { return value; }
  finally { value = 9; console.log("finally", value); }
}
function nested(): string {
  try {
    try { return "value"; }
    finally { console.log("inner finally"); }
  } finally { console.log("outer finally"); }
}
function replaced(): string {
  try {
    try { return "pending"; }
    finally { throw "replacement"; }
  } catch { return "replaced"; }
}
console.log(scan());
console.log(snapshot());
console.log(nested());
console.log(replaced());
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "completions"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; ")).toBe(true);
  if (!result.ok || result.backend !== "rust") return;
  expect(await readFile(result.sourcePath, "utf8")).toContain("runtime::Completion::Throw");
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 120_000);

test("supported scalar, heap, closure, and union corpus matches Node byte-for-byte", async () => {
  for (const fixture of [
    "001-hello.ts",
    "002-log-args.ts",
    "100-number-format.ts",
    "101-arithmetic.ts",
    "102-comparisons.ts",
    "103-ternary.ts",
    "104-ternary-empty-arrays.ts",
    "140-bitwise-operators.ts",
    "200-strings.ts",
    "201-templates.ts",
    "300-if-else.ts",
    "301-while.ts",
    "302-for.ts",
    "303-break-continue.ts",
    "304-compound-incdec.ts",
    "305-truthiness.ts",
    "400-fib.ts",
    "401-mutual-recursion.ts",
    "402-string-functions.ts",
    "403-void-and-params.ts",
    "500-array-basics.ts",
    "501-array-push-pop.ts",
    "504-array-rc-stress.ts",
    "511-array-indexof-includes.ts",
    "600-closures-basic.ts",
    "601-closures-loops.ts",
    "602-closures-identity-recursion.ts",
    "603-closures-rc-stress.ts",
    "604-closures-for-of.ts",
    "605-closures-forward-capture-tdz.ts",
    "700-classes-basic.ts",
    "701-classes-composition.ts",
    "702-classes-this-capture.ts",
    "703-classes-rc-stress.ts",
    "750-cycle-closure-box.ts",
    "751-cycle-records-mutual.ts",
    "752-cycle-classes.ts",
    "916-unknown-bytes.ts",
    "957-builtins-namespace.ts",
    "970-unions-basics.ts",
    "975-unions-undefined.ts",
    "979-unions-optional-chaining.ts",
    "980-exceptions-basics.ts",
    "984-exceptions-finally.ts",
    "1002-json-parse-cast.ts",
    "1004-json-parse-errors.ts",
    "1005-json-nested.ts",
    "1007-json-rc-stress.ts",
    "1011-json-unknown-typeof.ts",
    "1110-math-members.ts",
    "1111-math-random.ts",
    "1112-number-methods.ts",
    "1113-string-methods.ts",
    "1114-string-unicode-island.ts",
    "1115-parse-globals.ts",
    "1116-island-static-mix.ts",
    "1117-typeof-static-union.ts",
    "1118-object-spread-conditional.ts",
    "1119-switch-union.ts",
    "1121-infinity-number-tostring.ts",
    "1124-union-narrowed-retag.ts",
    "1200-regex-test-basics.ts",
    "1201-regex-replace.ts",
    "1202-regex-substitutions.ts",
    "1203-regex-split.ts",
    "1204-regex-empty-unicode.ts",
    "1205-regex-rc-stress.ts",
    "1301-errors-subclass.ts",
    "1302-errors-typed-catch.ts",
    "1303-errors-rc-stress.ts",
    "1306-errors-runtime-instances.ts",
    "1353-os-basics.ts",
    "1355-url-parse.ts",
    "1356-url-file-bridge.ts",
    "1358-crypto-random.ts",
    "1364-union-truthiness.ts",
    "1365-union-logical.ts",
    "1366-union-equality.ts",
    "1367-destructuring.ts",
    "1368-constructor-functions.ts",
    "1370-spread.ts",
    "1371-union-template-tostring.ts",
    "1372-loose-null-tests.ts",
    "1373-union-array-arms.ts",
    "1408-string-indexing.ts",
    "1420-number-statics.ts",
    "1421-number-parse-dynamic.ts",
    "1422-date-iso.ts",
    "1425-stdin-tty.ts",
    "1431-caught-tostring.ts",
    "1432-destructured-params.ts",
    "1435-math-spread.ts",
    "1437-pad-default.ts",
    "1444-exit-listeners.ts",
    "1450-incdec-expression.ts",
    "1451-instanceof-uint8array-unknown.ts",
    "1467-string-match.ts",
    "1476-assign-expression.ts",
    "1481-string-case-static.ts",
    "1520-string-split-static.ts",
    "1521-string-trim-pad-static.ts",
    "1522-parseint-static.ts",
    "1523-isnan-floor-static.ts",
    "1531-process-arch-versions.ts",
    "1534-union-as-arm-cast.ts",
    "1535-union-param-defaults.ts",
    "1536-destructuring-defaults.ts",
    "1536-string-array-sweep.ts",
    "1537-os-release-spawnsync-stdio.ts",
    "1538-math-static-scalar.ts",
    "1540-os-userinfo.ts",
    "1542-record-literal-into-union.ts",
    "1544-string-matchall.ts",
    "1545-spread-order-and-optional.ts",
    "1546-union-element-reads.ts",
    "1548-boolean-condition-forms.ts",
    "1549-array-isarray-unions.ts",
    "1556-union-retag-width-arms.ts",
    "1557-url-host.ts",
    "1577-url-hostname.ts",
    "1579-matchall-index.ts",
    "1611-url-file-bridge-neutral.ts",
    "1628-checked-dynamic-builtin-args.cjs",
    "1641-string-search.ts",
    "1664-dyn-fn-boundary.cjs",
    "1666-dyn-fn-identity.ts",
    "1669-symbol-identity.ts",
    "1670-symbol-registry.ts",
    "1671-symbol-typeof.ts",
    "1672-symbol-containers.ts",
    "1712-field-incdec.ts",
    "1791-searchparams-core.ts",
    "1792-searchparams-encoding.ts",
    "1793-searchparams-iteration.ts",
    "1794-searchparams-url-live.ts",
  "1980-primitive-proto-statics.ts",
    "1981-date-utc.ts",
    "2096-os-type.ts",
    "2140-uri-component-codecs.ts",
    "2163-js-selfref-const.cjs",
    "2191-uri-encoders.ts",
    "2193-discarded-stdlib-reads.ts",
    "2281-domexception-atob-btoa.cjs",
    "2283-structured-clone.cjs",
    "2286-dyn-object-walks.cjs",
    "2310-process-next-tick.ts",
    "2322-dyn-array-sort.cjs",
    "2350-nan-global.ts",
    "2366-string-well-formed.ts",
    "2367-regexp-escape.ts",
    "2381-builtin-default-imports.js",
    "2445-math-minmax-nary.ts",
    "2453-private-accessors.ts",
    "2472-string-regexp-union.ts",
    "2476-map-regex-values.ts",
    "2482-recursive-union-tree.ts",
    "2483-recursive-record-cycles.ts",
    "2582-jsval-object-statics.js",
    "2584-jsval-object-statics.js",
    "2586-object-assign-spread.js",
    "2594-nullish-generic-bindings.ts",
    "2608-regex-named-groups.ts",
    "2609-regex-named-replace.ts",
    "2610-regex-named-matchall.ts",
    "2611-regex-named-groups-js.cjs",
    "2675-create-require-nested-esm.js",
    "2676-record-clone-overrides.ts",
    "2677-runtime-optional-closure.ts",
    "2678-date-instances.ts",
    "2693-dyn-has-own.cjs",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-corpus-"));
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, "program"),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    if (fixture === "2483-recursive-record-cycles.ts" && result.backend === "rust") {
      expect(await readFile(result.sourcePath, "utf8")).toContain("enum sc_u_u0");
    }
    if (fixture === "700-classes-basic.ts" && result.backend === "rust") {
      const generated = await readFile(result.sourcePath, "utf8");
      expect(generated).toContain("struct sc_o_Point");
      expect(generated).toContain("runtime::Gc<sc_o_Point>");
      expect(generated).not.toContain("extern \"C\"");
    }
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 240_000);

test.each([
  "913-records-index-iteration.ts",
  "991-process-exit.ts",
  "1423-text-codec.ts",
  "1445-exit-process-exit.ts",
  "1446-exit-uncaught.ts",
  "518-promise-void-union-callbacks.ts",
  "1429-promise-catch-finally.ts",
  "1460-console-error-warn.ts",
  "1464-env-writes.ts",
  "1465-env-value.ts",
  "1477-in-expressions.ts",
  "1483-array-slice.ts",
  "1527-logical-mixed-operands.ts",
  "1528-delete-records-env.ts",
  "1533-path-platform-namespaces.ts",
  "1541-union-keyed-reads.ts",
  "1546-union-element-reads.ts",
  "1563-string-raw-fold.ts",
  "1564-string-raw.ts",
  "1562-optional-chain-tails.ts",
  "1574-dyn-optional-method-number-keys.ts",
  "1581-declare-const-read.ts",
  "1614-js-fence-dodges.cjs",
  "1630-inspect-scalars.ts",
  "1631-inspect-arrays.ts",
  "1632-inspect-records.ts",
  "1633-inspect-map-set.ts",
  "1634-inspect-classes.ts",
  "1635-inspect-buffer.ts",
  "1636-util-format.ts",
  "1637-inspect-dyn.ts",
  "1638-inspect-cjs.cjs",
  "1639-versions-openssl-probe.ts",
  "1642-object-fromentries-rows.ts",
  "1643-metadata-dyn-return.cjs",
  "1655-spawnsync-neutral.ts",
  "1656-execsync-neutral.ts",
  "1673-symbol-cjs.cjs",
  "1674-symbol-inspect.ts",
  "1679-console-dyn.js",
  "1685-stream-readable-basics.ts",
  "1686-stream-readable-paused.ts",
  "1687-stream-readable-flow-control.ts",
  "1688-stream-writable-basics.ts",
  "1689-stream-writable-async-drain.ts",
  "1690-stream-duplex.ts",
  "1691-stream-transform.ts",
  "1692-stream-pipe.ts",
  "1693-stream-pipe-backpressure.ts",
  "1694-stream-destroy.ts",
  "1695-stream-props.ts",
  "1696-stream-read-inside-read.ts",
  "1697-stream-tick-vs-timer.ts",
  "1698-stream-uncaught-error.ts",
  "1699-stream-callback-shapes.ts",
  "1713-js-dyn-fields.js",
  "1726-promise-with-resolvers.ts",
  "1730-countdown-symbol-keys/main.js",
  "1731-symbol-field-shapes.cjs",
  "1732-symbol-field-cross-module/main.js",
  "1760-surplus-args-drop.cjs",
  "810-do-while.ts",
  "1790-computed-key-folds.ts",
  "1800-immediate-basics.ts",
  "1801-immediate-handle.ts",
  "1802-immediate-unref-exit.ts",
  "1803-timeout-refresh.ts",
  "1804-timers-module.ts",
  "1805-timer-callback-args.ts",
  "1806-timer-delay-trunc.ts",
  "1810-stream-options-const-record.ts",
  "1820-static-block-basics.ts",
  "1821-static-block-order.ts",
  "1822-static-block-js.js",
  "1823-static-instance-method-names.ts",
  "1824-for-of-destructuring-defaults.ts",
  "1831-enum-string-const-reverse.ts",
  "1836-var-loop-capture.ts",
  "1837-var-undefined-hoisting.ts",
  "1838-var-modules/main.ts",
  "1839-var-js/main.cjs",
  "1850-overload-basics.ts",
  "1851-overload-return-narrowing.ts",
  "1852-overload-class-members.ts",
  "1853-overload-modules/main.ts",
  "1854-ambient-declare-fn.ts",
  "1870-unit-type-values.ts",
  "1871-empty-array-never.ts",
  "1872-template-tostring-composite.ts",
  "1880-json-declared-field-order.ts",
  "1881-default-anon/main.ts",
  "1882-default-cjs-interop/main.ts",
  "1883-default-exports/main.ts",
  "1890-ns-imports/main.ts",
  "1891-ns-reexport/main.ts",
  "1943-class-statics-expanded.ts",
  "1944-class-values-modules/main.ts",
  "1950-generic-fn-values.ts",
  "1954-generic-modules/main.ts",
  "1960-namespace-basics.ts",
  "1961-namespace-nested.ts",
  "1962-namespace-classes.ts",
  "1963-namespace-aliases.ts",
  "1964-namespace-type-only.ts",
  "1965-namespace-ambient.ts",
  "1966-namespace-modules/main.ts",
  "1968-namespace-import-eq-snapshot.ts",
  "1982-freeze-resolve-passthrough.ts",
  "1983-array-tuple-surfaces.ts",
  "1990-labels-basics.ts",
  "1991-for-in-loops.ts",
  "1992-small-syntax.ts",
  "2010-generators-basics.ts",
  "2011-generators-forof.ts",
  "2012-generators-return-throw.ts",
  "2013-generators-sent-values.ts",
  "2014-generators-values.ts",
  "2015-generators-yieldstar.ts",
  "2016-generators-rc-stress.ts",
  "2017-generators-async.ts",
  "2018-generators-uncaught.ts",
  "2019-generators-loops.ts",
  "2042-any-flow-loops.ts",
  "2053-typeof-static-fold.ts",
  "2060-empty-tuple.ts",
  "2100-stream-default-hwm.ts",
  "2106-comma-expressions.ts",
  "2212-unhandled-rejection-listener.cjs",
  "2250-tagged-templates.ts",
  "2253-union-coercions.ts",
  "2320-await-unit.ts",
  "2352-void-coercions.ts",
  "2363-nullish-retag.ts",
  "2386-string-to-chars.ts",
  "2387-tonumber-argv.ts",
  "2388-tonumber-grammar-zoo.ts",
  "2389-tonumber-unary-plus.ts",
  "2402-labeled-break-kill.ts",
  "2412-dowhile-guard-trailing-test.ts",
  "2413-dowhile-kill-renarrow.ts",
  "2414-dowhile-continue-kill.ts",
  "2415-dowhile-break-trailing-test.ts",
  "2440-console-inspect-args.ts",
  "2441-console-process-argv.ts",
  "2460-qs-parse-grammar.ts",
  "2461-qs-parse-options.ts",
  "2462-qs-stringify.ts",
  "2463-qs-escape-unescape.ts",
  "2464-qs-require-forms.cjs",
  "2470-mockable-module-shape.js",
  "2471-record-keyed-write-hasown.js",
  "2472-string-regexp-union.ts",
  "2473-option-table-widths.js",
  "2476-map-regex-values.ts",
  "2480-recursive-record-tree.ts",
  "2481-mutual-recursive-records.ts",
  "2482-recursive-union-tree.ts",
  "2483-recursive-record-cycles.ts",
  "2484-json-stringify-circular.ts",
  "2485-inspect-circular-refs.ts",
  "2486-recursive-record-boundaries.ts",
  "2488-ast-walker.ts",
  "2490-find-miss-null-compare.ts",
  "2491-strict-unit-compare-no-arm.ts",
  "2492-loose-null-compare-unions.ts",
  "2493-switch-unit-cases.ts",
  "2494-no-arm-compare-effects.ts",
  "2500-net-autosel-timeout.ts",
  "2520-private-statics-class-name-calls.ts",
  "2521-private-statics-class-expression.ts",
  "2523-private-statics-aliased-class.ts",
  "2530-object-destructuring-decl.ts",
  "2531-array-tuple-destructuring-decl.ts",
  "2532-param-destructuring-options.ts",
  "2533-forof-destructuring.ts",
  "2534-object-rest-decl.ts",
  "2535-destructuring-assign-basics.ts",
  "2536-destructuring-assign-nested.ts",
  "2537-destructuring-assign-member-targets.ts",
  "2538-destructuring-assign-class-source.ts",
  "2539-class-instance-rest.ts",
  "2540-accessor-destructuring-defaults.ts",
  "2541-destructuring-eval-order.ts",
  "2550-generics-keyof-pick.ts",
  "2551-generics-value-aliases.ts",
  "2552-generics-iface-methods.ts",
  "2553-generics-signature-bindings.ts",
  "2554-generics-frontier-mix.ts",
  "2555-generics-keyof-writes.ts",
  "2556-crypto-introspection.ts",
  "2556-width-hybrid-shapes.ts",
  "2557-tls-ca-store.ts",
  "2557-width-field-lifts.ts",
  "2558-index-signature-func-values.ts",
  "2558-rejection-events.cjs",
  "2559-index-signature-container-values.ts",
  "2560-arraybuffer-dataview-set.ts",
  "2561-object-is.ts",
  "2562-intl-numberformat-en-us.ts",
  "2566-promise-reject-dyn-reason.js",
  "2567-rest-spread-forward.js",
  "2568-rest-spread-forward-dynamic.js",
  "2569-upcast-identity.ts",
  "2591-ambient-generic-traps.ts",
  "2613-for-init-uninitialized-let.ts",
  "2643-or-default-retag.ts",
  "2654-top-level-await-unrelated-rejection.ts",
  "2664-top-level-await-same-checkpoint-rejection.ts",
  "2665-top-level-await-unhandled-listener-liveness.ts",
  "2678-util-parseargs.ts",
  "2679-util-parseargs-cjs.cjs",
  "2694-path-win32-full.ts",
  "2697-process-chdir.ts",
  "2698-process-umask.ts",
])("Rust environment and late language corpus matches Node: %s", async (fixture) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-logical-tail-"));
  const entryPath = resolve("tests/corpus", fixture);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, fixture.replace(/\.ts$/, "")),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
  ).toBe(true);
  if (!result.ok) return;
  if (fixture === "2470-mockable-module-shape.js" && result.backend === "rust") {
    expect(await readFile(result.sourcePath, "utf8")).toContain(
      "Cannot add property '{}' to a fixed-shape object",
    );
  }
  if (fixture === "2538-destructuring-assign-class-source.ts" && result.backend === "rust") {
    expect(await readFile(result.sourcePath, "utf8")).toMatch(
      /sc_fld_miss: Some\(sc_u_[A-Za-z0-9_]+::ScArm\d+\)/u,
    );
  }
  if (fixture === "2486-recursive-record-boundaries.ts" && result.backend === "rust") {
    const source = await readFile(result.sourcePath, "utf8");
    expect(source).toContain("fn sc_dyn_from_");
    expect(source).toContain("runtime::dyn_from_enter");
  }
  const env = { ...process.env, SCRIPTC_TEST_ENV: "scriptc-test-value" };
  const nodeArgs = await nodeCorpusArgs(entryPath);
  const [node, rust] = await Promise.all([
    runToExit(process.execPath, nodeArgs, env),
    runToExit(result.binaryPath, [], { ...env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
  ]);
  const directive = (await readFile(entryPath, "utf8")).split("\n", 2)
    .map((line) => /^\/\/ @exit:\s*(\d+)\s*$/u.exec(line)?.[1])
    .find((value) => value !== undefined);
  if (directive === undefined || Number(directive) === 0) {
    expect(rust, fixture).toEqual(node);
  } else {
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(node.exitCode, fixture).toBe(Number(directive));
    expect(rust.exitCode, fixture).toBe(Number(directive));
    expect(rust.stderr, fixture).not.toContain("Rust heap object(s) still live");
  }
}, 240_000);

test.each([
  ["2592-ambient-trap-uncaught.ts", "t is not defined"],
  ["2614-trap-binding-later-writes.ts", "numLiteral is not defined"],
])("Rust uncaught ambient read preserves exit, stdout, and ReferenceError: %s", async (fixture, message) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-ambient-exit-"));
  const entryPath = resolve("tests/corpus", fixture);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, fixture.replace(/\.ts$/, "")),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
  ).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.exitCode).toBe(node.exitCode);
  expect(node.stderr).toContain(`ReferenceError: ${message}`);
  expect(rust.stderr).toContain(`Uncaught ReferenceError: ${message}`);
  expect(rust.stderr).not.toContain("Rust heap object(s) still live");
}, 240_000);

test("Rust record clones preserve evaluation across async suspension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-record-clone-async-"));
  const entryPath = join(dir, "record-clone-async.ts");
  await writeFile(entryPath, `
interface Config {
  label: string;
  value: number;
  nested: { tag: string };
}

const trace: string[] = [];
const base: Config = { label: "base", value: 1, nested: { tag: "nested" } };

function source(value: Config, name: string): Config {
  trace.push(name);
  return value;
}

async function label(): Promise<string> {
  trace.push("label:start");
  await Promise.resolve();
  trace.push("label:end");
  return "plain";
}

async function number(): Promise<number> {
  trace.push("number:start");
  await Promise.resolve();
  trace.push("number:end");
  return 3;
}

async function build(): Promise<Config> {
  const plain: Config = { ...source(base, "source:plain"), label: await label() };
  try {
    return { ...source(plain, "source:protected"), value: await number() };
  } finally {
    trace.push("finally");
  }
}

const result = await build();
result.nested.tag = "shared";
console.log(result.label, result.value, base.label, base.value, base.nested.tag);
console.log(trace.join(","));
export {};
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "record-clone-async"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok || result.backend !== "rust") return;
  expect(await readFile(result.sourcePath, "utf8")).toContain("sc_async_record_clone_");
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 120_000);

test("Rust checked-dynamic adapters validate JSON, arguments, and results catchably", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dyn-functions-"));
  const entryPath = join(dir, "dyn-function-errors.ts");
  await writeFile(entryPath, `
const parsed: unknown = JSON.parse('"wrong"');
try {
  console.log(parsed as number);
} catch {
  console.log("JSON mismatch caught");
}

function takesNumber(value: number): number { return value + 1; }
const boxedArgument: unknown = takesNumber;
const acceptsString = boxedArgument as (value: string) => unknown;
try {
  acceptsString("wrong");
} catch {
  console.log("argument mismatch caught");
}

function returnsString(): string { return "wrong"; }
const boxedResult: unknown = returnsString;
const returnsNumber = boxedResult as () => number;
try {
  console.log(returnsNumber());
} catch {
  console.log("result mismatch caught");
}

const nested: unknown = JSON.parse('{"items":[1,"wrong"]}');
console.log((nested as { items: number[] }).items.length);
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "dyn-function-errors"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok || result.backend !== "rust") return;
  const outcome = await runToExit(result.binaryPath, [], {
    ...process.env,
    SCRIPTC_RUST_HEAP_AUDIT: "1",
  });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.stdout).toBe(
    "JSON mismatch caught\nargument mismatch caught\nresult mismatch caught\n",
  );
  expect(outcome.stderr).toContain(
    "Uncaught TypeError: expected number at $.items[1], got string",
  );
}, 120_000);

test("Rust recursive typed-to-dynamic copies reject cycles before recursion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dyn-cycle-"));
  const entryPath = join(dir, "dyn-cycle.ts");
  await writeFile(entryPath, `
interface Link { next: Link | null }
const link: Link = { next: null };
link.next = link;
const boxed: unknown = link;
console.log(boxed);
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "dyn-cycle"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok || result.backend !== "rust") return;
  const outcome = await runToExit(result.binaryPath);
  expect(outcome.stderr).toContain(
    "cannot convert a circular structure into a checked-dynamic value",
  );
  expect(outcome.stderr).not.toContain("stack overflow");
}, 120_000);

test("Rust dynamic objects, arrays, strings, and function properties match Node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dyn-properties-"));
  const entryPath = join(dir, "dyn-properties.ts");
  await writeFile(entryPath, `
"use strict";
function pass(value: any): any { return value; }
const object: any = JSON.parse('{"a":1,"b":"x"}');
object.c = true;
console.log(object.a, object.b, object.c, typeof object.missing);
const array: any = JSON.parse("[1,2]");
array[3] = 4;
console.log(array.length, array[0], typeof array[2], array[3]);
const text = pass("abc");
console.log(text.length, text[0], text[2], typeof text[3]);
function named(left: number, right: number): number { return left + right; }
const fn = pass(named);
fn.extra = 7;
console.log(fn.name, fn.length, fn.extra, fn(2, 3));
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "dyn-properties"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok || result.backend !== "rust") return;
  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  expect(rust).toEqual(node);
}, 120_000);

test("Rust dynamic calls preserve catchable and uncaught failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dyn-call-errors-"));
  for (const [fixture, uncaught] of [
    ["1667-dyn-fn-not-callable.cjs", "Uncaught TypeError: s is not a function"],
    ["1668-dyn-fn-throws.cjs", "Uncaught RangeError: too big: 9"],
  ] as const) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -4)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok || result.backend !== "rust") continue;
    const [node, rust] = await Promise.all([
      runToExit(process.execPath, [entryPath]),
      runToExit(result.binaryPath, [], {
        ...process.env,
        SCRIPTC_RUST_HEAP_AUDIT: "1",
      }),
    ]);
    expect(node.exitCode, fixture).toBe(1);
    expect(rust.exitCode, fixture).toBe(node.exitCode);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toContain(uncaught);
    expect(rust.stderr, fixture).not.toContain("Rust heap object(s) still live");
  }
}, 120_000);

test("Rust array ranges, removals, copying, and reverse searches match Node byte-for-byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-array-ranges-"));
  for (const fixture of [
    "1532-array-splice-shift.ts",
    "1543-rest-destructuring.ts",
    "1676-func-array-surface.ts",
    "2112-array-at-findlast.ts",
    "2669-array-copying-methods.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok || result.backend !== "rust") continue;
    const generated = await readFile(result.sourcePath, "utf8");
    expect(generated, fixture).not.toMatch(/\bunsafe\s*\{/);
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 240_000);

test("Rust Buffer and StringDecoder byte surfaces match Node byte-for-byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-buffer-surface-"));
  for (const fixture of [
    "1474-string-decoder.ts",
    "1660-buffer-read-write-num.ts",
    "1661-buffer-encodings-full.ts",
    "1662-string-decoder-encodings.ts",
    "1663-buffer-compare-search-fill.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok || result.backend !== "rust") continue;
    const generated = await readFile(result.sourcePath, "utf8");
    expect(generated, fixture).not.toMatch(/\bunsafe\s*\{/);
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 240_000);

test("unsupported Rust IR refuses instead of falling back to C or LLVM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-refusal-"));
  const sourcePath = join(dir, "unsupported.ts");
  await writeFile(
    sourcePath,
    'import { networkInterfaces } from "node:os";\nconsole.log(networkInterfaces());\n',
  );
  const result = await compile(sourcePath, {
    outDir: dir,
    outPath: join(dir, "unsupported"),
    backend: "rust",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics[0]?.code).toBe("SC3001");
  expect(result.diagnostics[0]?.message).toContain("rust backend does not support");
}, 120_000);

test("Rust class inheritance, dispatch, instanceof, accessors, and cycles match Node", async () => {
  for (const fixture of [
    "710-inheritance-basics.ts",
    "711-inheritance-dispatch.ts",
    "712-inheritance-instanceof.ts",
    "713-inheritance-rc-stress.ts",
    "720-accessors-basics.ts",
    "721-accessors-eval-order.ts",
    "722-accessors-inheritance.ts",
    "723-accessors-rc-stress.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-class-hierarchy-"));
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, "class-hierarchy"),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok || result.backend !== "rust") continue;
    const generated = await readFile(result.sourcePath, "utf8");
    if (fixture.startsWith("71")) expect(generated, fixture).toContain("sc_class_pre");
    expect(generated, fixture).not.toMatch(/\bunsafe\s*\{/);
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 120_000);

test("Rust abstract class slots dispatch through concrete descendants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-abstract-classes-"));
  const entryPath = join(dir, "abstract-classes.ts");
  await writeFile(entryPath, `
abstract class Shape {
  name: string;
  constructor(name: string) { this.name = name; }
  abstract area(): number;
  abstract get scale(): number;
  describe(): string { return this.name + "=" + this.area() * this.scale; }
}
abstract class Polygon extends Shape {
  abstract area(): number;
}
class Square extends Polygon {
  private side: number;
  constructor(side: number) { super("square"); this.side = side; }
  area(): number { return this.side * this.side; }
  get scale(): number { return 2; }
}
class Circle extends Shape {
  private radius: number;
  constructor(radius: number) { super("circle"); this.radius = radius; }
  area(): number { return 3 * this.radius * this.radius; }
  get scale(): number { return 1; }
}
const shapes: Shape[] = [new Square(4), new Circle(2)];
for (const shape of shapes) console.log(shape.describe(), shape instanceof Polygon);
`);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "abstract-classes"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    execFileAsync(process.execPath, [entryPath]),
    execFileAsync(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toBe(node.stderr);
}, 120_000);

test("Rust class values, expressions, and generics preserve identity, statics, hierarchy, and dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-class-values-"));
  for (const fixture of [
    "1940-class-values-basics.ts",
    "1942-class-expressions.ts",
    "1951-generic-classes-basics.ts",
    "1952-generic-class-statics-values.ts",
    "1953-generic-class-hierarchy.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok || result.backend !== "rust") continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 120_000);

test("Rust Map and Set containers preserve equality, live iteration, references, and class registries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-map-set-"));
  for (const fixture of [
    "520-map-basics.ts",
    "521-map-number-keys.ts",
    "522-map-foreach.ts",
    "523-map-ref-values.ts",
    "524-map-cycles.ts",
    "525-map-rc-stress.ts",
    "526-set-basics.ts",
    "527-set-foreach.ts",
    "528-set-seeded.ts",
    "529-map-seeded.ts",
    "536-map-seed-array.ts",
    "537-map-iter-drains.ts",
    "538-map-set-for-of.ts",
    "1941-class-values-registry.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 240_000);

test("Rust process reads and POSIX path operations match Node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-node-basics-"));
  const env = { ...process.env, SCRIPTC_TEST_ENV: "from-harness" };
  for (const fixture of [
    "990-process-basics.ts",
    "998-process-env.ts",
    "1350-path-normalize-join.ts",
    "1351-path-parts.ts",
    "1352-path-resolve-relative.ts",
    "1520-string-split-static.ts",
    "1522-parseint-static.ts",
    "1531-process-arch-versions.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath], { env }),
      execFileAsync(result.binaryPath, [], {
        env: { ...env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 180_000);

test("Rust synchronous filesystem operations match Node and throw catchably", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-fs-sync-"));
  for (const fixture of [
    "992-fs-roundtrip.ts",
    "993-fs-readdir.ts",
    "994-fs-errors.ts",
    "1006-json-fs-config.ts",
    "1520-fs-wider-surface.ts",
    "2685-fs-write-sync.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
  const realpathEntry = join(dir, "realpath.ts");
  await writeFile(realpathEntry, `
import { lstatSync, realpathSync, statSync } from "node:fs";
console.log(realpathSync(".") === process.cwd());
const stats = statSync(".");
console.log(stats.isDirectory(), stats.isFile(), stats.isSymbolicLink());
console.log(stats.size >= 0, stats.blocks >= 0, stats.nlink >= 1, stats.atimeMs > 0, stats.mtimeMs > 0);
console.log(lstatSync(".").isSymbolicLink());
try { realpathSync("scriptc-rust-definitely-missing"); }
catch (error) {
  if (error instanceof Error) {
    console.log("caught realpath", (error as NodeJS.ErrnoException).code);
  }
}
`);
  const realpathResult = await compile(realpathEntry, {
    outDir: dir,
    outPath: join(dir, "realpath"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    realpathResult.ok,
    realpathResult.ok ? undefined : realpathResult.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (realpathResult.ok) {
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [realpathEntry]),
      execFileAsync(realpathResult.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stderr).toBe(node.stderr);
  }
}, 180_000);

test("Rust synchronous child processes capture output and throw catchably", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-child-sync-"));
  for (const fixtureName of ["1552-exec-options-record.ts", "1360-spawn-sync.ts"]) {
    const fixture = resolve("tests/corpus", fixtureName);
    const fixtureResult = await compile(fixture, {
      outDir: dir,
      outPath: join(dir, fixtureName.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      fixtureResult.ok,
      fixtureResult.ok ? fixture : fixtureResult.diagnostics.map((diag) => diag.message).join("; "),
    ).toBe(true);
    if (fixtureResult.ok) {
      const [node, rust] = await Promise.all([
        execFileAsync(process.execPath, [fixture]),
        execFileAsync(fixtureResult.binaryPath, [], {
          env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
        }),
      ]);
      expect(rust.stdout, fixtureName).toBe(node.stdout);
      expect(rust.stderr, fixtureName).toBe(node.stderr);
    }
  }

  const errorsEntry = join(dir, "exec-errors.ts");
  await writeFile(errorsEntry, `
import { execFileSync, execSync, spawnSync } from "node:child_process";
console.log(JSON.stringify(execFileSync("/usr/bin/printf", ["%s", "direct ok"], { encoding: "utf8" })));
console.log(JSON.stringify(execSync("printf 'shell ok'", { encoding: "utf8", stdio: "pipe" })));
console.log(JSON.stringify(execFileSync("/bin/cat", [], { encoding: "utf8", input: "fed input" })));
try {
  execFileSync("/bin/sh", ["-c", "echo failed-line 1>&2; exit 3"], { encoding: "utf8", stdio: "pipe" });
} catch (error) {
  if (error instanceof Error) console.log(JSON.stringify(error.message));
}
try {
  execFileSync("scriptc-rust-definitely-missing", [], { encoding: "utf8", stdio: "pipe" });
} catch (error) {
  if (error instanceof Error) console.log(error.message, (error as NodeJS.ErrnoException).code);
}
try {
  execFileSync("/bin/sleep", ["1"], { encoding: "utf8", stdio: "pipe", timeout: 20 });
} catch (error) {
  if (error instanceof Error) console.log(error.message, (error as NodeJS.ErrnoException).code);
}
const missing = spawnSync("scriptc-rust-definitely-missing", [], { encoding: "utf8" });
if (missing.error) {
  const error = missing.error as NodeJS.ErrnoException;
  console.log(missing.status === null, error.message, error.code);
}
const timed = spawnSync("/bin/sleep", ["1"], { encoding: "utf8", stdio: "pipe", timeout: 20 });
if (timed.error) {
  const error = timed.error as NodeJS.ErrnoException;
  console.log(timed.status === null, timed.signal, error.message, error.code);
}
`);
  const errorsResult = await compile(errorsEntry, {
    outDir: dir,
    outPath: join(dir, "exec-errors"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    errorsResult.ok,
    errorsResult.ok ? undefined : errorsResult.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (errorsResult.ok) {
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [errorsEntry]),
      execFileAsync(errorsResult.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stderr).toBe(node.stderr);
  }
}, 120_000);

test("Rust timers, immediates, and microtasks preserve ordering and liveness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-timers-"));
  const entry = join(dir, "timers.ts");
  await writeFile(entry, `
let value = "before";
queueMicrotask(() => {
  console.log("micro", value);
  process.nextTick(() => console.log("tick-from-micro"));
});
queueMicrotask(() => console.log("micro-two"));
process.nextTick(() => console.log("nextTick", value));
setTimeout(() => {
  console.log("zero", value);
  setTimeout(() => console.log("nested"), 0);
}, 0);
const cancelled = setImmediate(() => console.log("cancelled"));
clearImmediate(cancelled);
setImmediate(() => console.log("immediate"));
const immediateHandle = setImmediate(() => console.log("handled immediate"));
console.log("immediate hasRef", immediateHandle.hasRef());
immediateHandle.unref();
console.log("immediate hasRef", immediateHandle.hasRef());
immediateHandle.ref();
console.log("immediate hasRef", immediateHandle.hasRef());
const dead = setTimeout(() => console.log("dead"), 0);
clearTimeout(dead);
let ticks = 0;
const interval = setInterval(() => {
  ticks += 1;
  console.log("tick", ticks);
  if (ticks === 2) clearInterval(interval);
}, 0);
const unreffed = setTimeout(() => console.log("unreffed"), 100);
unreffed.unref();
console.log("hasRef", unreffed.hasRef());
unreffed.ref();
console.log("hasRef", unreffed.hasRef());
clearTimeout(unreffed);
const refreshed = setTimeout(() => console.log("refreshed"), 4);
refreshed.refresh();
setTimeout(() => console.log("later"), 25);
const timerBarrier = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(timerBarrier, 0, 0, 5);
value = "after";
console.log("sync", value);
`);
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "timers"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (result.ok) {
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entry]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stderr).toBe(node.stderr);
  }
}, 120_000);

test("Rust Immediate references control event-loop liveness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-immediate-ref-"));
  const entry = join(dir, "immediate-ref.ts");
  await writeFile(entry, `
setImmediate(() => console.log("unreffed neighbor")).unref();
setImmediate(() => {
  console.log("keeper");
  const orphan = setImmediate(() => console.log("orphan"));
  orphan.unref();
  console.log("orphan hasRef", orphan.hasRef());
});
console.log("main");
`);
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "immediate-ref"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (result.ok) {
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entry]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stderr).toBe(node.stderr);
  }
}, 120_000);

test("Rust monotonic clocks and Atomics.wait match Node invariants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-clock-wait-"));
  for (const fixture of ["2427-perf-hooks-now.ts", "1524-atomics-sleep-static.ts"]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 120_000);

test("Rust active resource snapshots track timer and Immediate lifetimes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-active-resources-"));
  const entry = join(dir, "active-resources.ts");
  await writeFile(entry, `
const count = (kind: string): number =>
  process.getActiveResourcesInfo().filter((value) => value === kind).length;
console.log("empty", count("Timeout"), count("Immediate"));
const timer = setTimeout(() => {
  console.log("timer firing", count("Timeout"));
  clearTimeout(timer);
  console.log("timer cleared", count("Timeout"));
  setImmediate(() => console.log("immediate firing", count("Immediate")));
  console.log("immediate armed", count("Immediate"));
}, 0);
console.log("timer armed", count("Timeout"));
`);
  const result = await compile(entry, {
    outDir: dir,
    outPath: join(dir, "active-resources"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? undefined : result.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (result.ok) {
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entry]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stderr).toBe(node.stderr);
  }
}, 120_000);

test("Rust process introspection and Number predicates preserve Node invariants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-process-usage-"));
  for (const fixture of ["2314-process-introspection.ts", "1420-number-statics.ts"]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
}, 120_000);

test("Rust async state machines resume settled promises on microtasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-async-resolve-"));
  const entry = join(dir, "async-resolve.ts");
  await writeFile(entry, `
import { setTimeout as sleep, setImmediate as tick } from "node:timers/promises";
async function compute(): Promise<number> {
  console.log("compute start");
  const value = await Promise.resolve(40);
  console.log("compute resumed");
  return value + 2;
}
console.log("main start");
const answer = await compute();
console.log("answer", answer);
setTimeout(() => console.log("callback timer"), 0);
await sleep(5);
console.log("promise timer");
await tick();
console.log("promise immediate");
queueMicrotask(() => console.log("before value hop"));
await null;
console.log("after value hop");
const firstSettle = await new Promise<number>((resolvePromise) => {
  resolvePromise(3);
  resolvePromise(4);
});
console.log("first settle", firstSettle);
const mapped = await Promise.resolve(5).then((value) => value + 1);
console.log("mapped", mapped);
function makeAsync(prefix: string): () => Promise<string> {
  return async () => {
    await sleep(1);
    return prefix + "tured";
  };
}
const captureFn = makeAsync("cap");
const captured = await captureFn();
console.log("capture", captured);
const raced = await Promise.race([Promise.resolve(1), Promise.resolve(2)]);
console.log("race", raced);
const pendingRace = await Promise.race([
  new Promise<number>((resolveRace) => setTimeout(() => resolveRace(3), 5)),
  new Promise<number>((resolveRace) => setTimeout(() => resolveRace(4), 1)),
]);
console.log("pending race", pendingRace);
const all: number[] = await Promise.all([Promise.resolve(5), Promise.resolve(6)]);
console.log("all", all.join(","));
const pendingAll: number[] = await Promise.all([
  new Promise<number>((resolveAll) => setTimeout(() => resolveAll(7), 5)),
  new Promise<number>((resolveAll) => setTimeout(() => resolveAll(8), 1)),
]);
console.log("pending all", pendingAll.join(","));
await Promise.all([sleep(1), sleep(2)]);
console.log("all void");
console.log("inline await", await Promise.resolve(9));
const left = Promise.resolve(10);
const right = Promise.resolve(11);
console.log("multiple awaits", await left, await right);
function argument(value: number): number {
  console.log("argument", value);
  return value;
}
console.log("ordered", argument(12), await Promise.resolve(13), argument(14));
console.error("inline error", await Promise.resolve(15));
const awaitRight = argument(16) + await Promise.resolve(17);
console.log("await right", awaitRight);
const awaitLeft = await Promise.resolve(18) + argument(19);
console.log("await left", awaitLeft);
async function rejectAfterAwait(): Promise<number> {
  await Promise.resolve(0);
  throw new Error("caught after await");
}
async function recoverRejection(): Promise<string> {
  try {
    await rejectAfterAwait();
    return "unreachable";
  } catch (error) {
    if (error instanceof Error) return error.message;
    return "unknown";
  }
}
console.log("recovered", await recoverRejection());
async function recoverStaticRejection(): Promise<string> {
  try {
    await Promise.reject(new TypeError("static rejection"));
    return "unreachable";
  } catch (error) {
    if (error instanceof TypeError) return error.name + ": " + error.message;
    return "unknown";
  }
}
console.log("static recovered", await recoverStaticRejection());
function rejectedByExecutor(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    reject(new TypeError("executor rejection"));
    resolve(99);
  });
}
async function recoverExecutorRejection(): Promise<string> {
  try {
    await rejectedByExecutor();
    return "unreachable";
  } catch (error) {
    if (error instanceof TypeError) return error.name + ": " + error.message;
    return "unknown";
  }
}
console.log("executor recovered", await recoverExecutorRejection());
function resolvedBeforeReject(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    resolve("winner");
    reject(new Error("too late"));
  });
}
console.log("executor first", await resolvedBeforeReject());
async function throwFromCatch(): Promise<number> {
  try {
    await rejectAfterAwait();
    return 0;
  } catch {
    throw new RangeError("catch failed");
  }
}
async function recoverCatchThrow(): Promise<string> {
  try {
    await throwFromCatch();
    return "unreachable";
  } catch (error) {
    if (error instanceof RangeError) return error.name + ": " + error.message;
    return "unknown";
  }
}
console.log("catch throw", await recoverCatchThrow());
function optionalNumber(present: boolean): Promise<number> | undefined {
  return present ? Promise.resolve(20) : undefined;
}
function optionalVoid(present: boolean): Promise<void> | undefined {
  return present ? Promise.resolve() : undefined;
}
const optionalPresent = await optionalNumber(true);
console.log("optional present", optionalPresent === 20);
const optionalMissing = await optionalNumber(false);
console.log("optional missing", optionalMissing === undefined);
await optionalVoid(false);
console.log("optional void");
async function finallyAfterAwait(): Promise<string> {
  let trace = "";
  try {
    await Promise.resolve(1);
    trace = trace + "try";
  } finally {
    await Promise.resolve(2);
    trace = trace + "-finally";
  }
  return trace;
}
console.log("finally await", await finallyAfterAwait());
async function returnThroughFinally(): Promise<string> {
  try {
    await Promise.resolve(0);
    return "pending return";
  } finally {
    console.log("return finally");
  }
}
console.log("finally return", await returnThroughFinally());
async function finallyOverridesReturn(): Promise<string> {
  try {
    await Promise.resolve(0);
    return "discarded return";
  } finally {
    throw new RangeError("finally failed");
  }
}
async function recoverFinallyThrow(): Promise<string> {
  try {
    await finallyOverridesReturn();
    return "unreachable";
  } catch (error) {
    if (error instanceof RangeError) return error.message;
    return "unknown";
  }
}
console.log("finally throw", await recoverFinallyThrow());
const pushedAcrossAwait: string[] = [];
function pushReceiver(): string[] {
  console.log("push receiver");
  return pushedAcrossAwait;
}
async function pushArgument(): Promise<string> {
  console.log("push argument start");
  await Promise.resolve(0);
  console.log("push argument end");
  return "middle";
}
const pushedLength = pushReceiver().push("first", await pushArgument(), "last");
console.log("push length", pushedLength);
console.log("push values", pushedAcrossAwait.join(","));
export {};
`);
  for (const [name, entryPath] of [
    ["async-resolve", entry],
    ["top-level-await", resolve("tests/corpus/2673-top-level-await-implicit-module.ts")],
    ["top-level-await-promise", resolve("tests/corpus/2646-top-level-await.ts")],
    ["timers-promises", resolve("tests/corpus/2093-timers-promises.ts")],
    ["settled-await-order", resolve("tests/corpus/1428-settled-await-order.ts")],
    ["async-basics", resolve("tests/corpus/1020-async-basics.ts")],
    ["async-ordering", resolve("tests/corpus/1021-async-ordering.ts")],
    ["async-rc-stress", resolve("tests/corpus/1023-async-rc-stress.ts")],
    ["throw-promise", resolve("tests/corpus/1026-throw-promise.ts")],
    ["async-return-promise", resolve("tests/corpus/1027-async-return-promise.ts")],
    ["async-promise-capture", resolve("tests/corpus/1025-async-promise-capture.ts")],
    ["async-return-records", resolve("tests/corpus/1028-async-return-record-literals.ts")],
    ["async-eager-chains", resolve("tests/corpus/1029-async-eager-chains.ts")],
    ["async-promise-cycle", resolve("tests/corpus/755-cycle-async-promise.ts")],
    ["promise-union-await-values", resolve("tests/corpus/519-promise-union-await-values.ts")],
    ["promise-union", resolve("tests/corpus/1369-promise-union.ts")],
    ["promise-all-array", resolve("tests/corpus/1438-promise-all.ts")],
    ["promise-race", resolve("tests/corpus/1430-promise-race.ts")],
    ["promise-all-tuple-literal", resolve("tests/corpus/1574-promise-all-tuple-literal.ts")],
    ["promise-try", resolve("tests/corpus/2369-promise-try.ts")],
    ["fsp-roundtrip", resolve("tests/corpus/1357-fsp-roundtrip.ts")],
    ["fsp-mkdir-unlink-chmod", resolve("tests/corpus/1569-fsp-mkdir-unlink-chmod.ts")],
    ["fsp-write-file-options", resolve("tests/corpus/2687-fsp-write-file-options.ts")],
    ["fs-rename-callback", resolve("tests/corpus/2682-fs-rename.ts")],
    ["fs-file-handle", resolve("tests/corpus/2686-fs-file-handle.ts")],
    ["fs-stats-disk-fields", resolve("tests/corpus/2688-fs-stats-disk-fields.ts")],
    ["buffer-fs", resolve("tests/corpus/1403-buffer-fs.ts")],
    ["map-promise-values", resolve("tests/corpus/1542-map-promise-values.ts")],
    ["params-async-generics", resolve("tests/corpus/409-params-async-generics.ts")],
    ["errors-async-rejections", resolve("tests/corpus/1305-errors-async-rejections.ts")],
    ["promise-reject", resolve("tests/corpus/1478-promise-reject.ts")],
    ["destructuring-assign", resolve("tests/corpus/1479-destructuring-assign.ts")],
    ["return-through-finally", resolve("tests/corpus/1452-return-through-finally.ts")],
    ["await-promiselike-return", resolve("tests/corpus/1538-await-promiselike-return.ts")],
    ["promise-then", resolve("tests/corpus/1561-promise-then.ts")],
    ["generics-async", resolve("tests/corpus/965-generics-async.ts")],
    ["generic-member-fields-async", resolve("tests/corpus/2432-generic-member-fields-async.ts")],
    ["void-statement", resolve("tests/corpus/1540-void-statement.ts")],
    ["await-unit", resolve("tests/corpus/2320-await-unit.ts")],
    ["async-pending-exit", resolve("tests/corpus/1024-async-pending-exit.ts")],
    ["async-methods", resolve("tests/corpus/2351-async-methods.ts")],
    ["async-never", resolve("tests/corpus/1434-async-never.ts")],
    ["promise-catch-finally", resolve("tests/corpus/1429-promise-catch-finally.ts")],
    ["promise-with-resolvers", resolve("tests/corpus/1726-promise-with-resolvers.ts")],
    ["promise-reject-all", resolve("tests/corpus/1572-promise-reject-all-tuple.ts")],
  ] as const) {
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, name),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? name : `${name}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, name).toBe(node.stdout);
    expect(rust.stderr, name).toBe(node.stderr);
  }
}, 120_000);

test("Rust unhandled async rejection matches the official exit-one corpus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-async-unhandled-"));
  const entryPath = resolve("tests/corpus/1022-async-exceptions.ts");
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "async-exceptions"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok
      ? undefined
      : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  expect(node.exitCode).toBe(1);
  expect(rust.exitCode).toBe(node.exitCode);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toContain("UnhandledPromiseRejection: boom: unhandled-path");
  expect(rust.stderr).not.toContain("Rust heap object(s) still live");
}, 120_000);

test("Rust uncaught Error subclass matches the official exit-one corpus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-uncaught-error-"));
  const entryPath = resolve("tests/corpus/1304-errors-uncaught.ts");
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, "errors-uncaught"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok
      ? undefined
      : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;

  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  expect(node.exitCode).toBe(1);
  expect(rust.exitCode).toBe(node.exitCode);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.stderr).toContain("Uncaught FatalError: unrecoverable");
  expect(rust.stderr).not.toContain("Rust heap object(s) still live");
}, 120_000);

test("Rust typed arrays, byte unions, copies, views, and set match Node", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-bytes-"));
  for (const fixture of [
    "1400-typedarray-basics.ts",
    "1401-typedarray-slice-set.ts",
    "1402-buffer-encodings.ts",
    "1405-bytes-unions-arrays.ts",
    "1455-lambda-union-return-adoption.ts",
    "2670-uint8array-copy-iterate.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [entryPath]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.stderr, fixture).toBe(node.stderr);
  }
  const fsEntry = join(dir, "bytes-fs.ts");
  await writeFile(fsEntry, `
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const path = "tmp-rust-bytes-" + process.pid + ".bin";
writeFileSync(path, Buffer.from("00ff80eda0bd0a", "hex"));
const back = readFileSync(path);
console.log(back.length, back[0], back[1], back.toString("hex"));
console.log(back.toString("hex", 1, 4), JSON.stringify(back.toString("utf8", 3, 2)));
writeFileSync(path, new Uint8Array([1, 0, 2]));
console.log(readFileSync(path).toString("hex"));
const fd = openSync(path, "r");
console.log(readFileSync(fd).toString("hex"));
closeSync(fd);
rmSync(path);
`);
  const fsResult = await compile(fsEntry, {
    outDir: dir,
    outPath: join(dir, "bytes-fs"),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    fsResult.ok,
    fsResult.ok ? undefined : fsResult.diagnostics.map((diag) => diag.message).join("; "),
  ).toBe(true);
  if (fsResult.ok) {
    const [node, rust] = await Promise.all([
      execFileAsync(process.execPath, [fsEntry]),
      execFileAsync(fsResult.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stderr).toBe(node.stderr);
  }
}, 120_000);

test("Rust switch dispatch preserves lazy tests, fallthrough, shared scope, and narrowing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-switch-"));
  for (const fixture of [
    "1119-switch-union.ts",
    "1532-union-shared-field-read.ts",
    "1825-exhaustive-typeof-switch.ts",
    "1830-enum-numeric-basics.ts",
    "1835-var-basics.ts",
    "2398-switch-arm-kill.ts",
    "2406-switch-clause-sibling-narrow.ts",
    "2410-stacked-cases-terminality.ts",
    "2411-exhaustive-switch-terminality.ts",
    "2419-selector-ternary-union.ts",
    "2442-union-literal-arm-widening.ts",
    "2443-union-literal-shadow-narrowing.ts",
    "2444-union-literal-reducer-spread.ts",
    "2488-ast-walker.ts",
    "2493-switch-unit-cases.ts",
    "800-switch-basics.ts",
    "801-switch-lazy-tests.ts",
    "803-switch-rc-stress.ts",
    "804-switch-braced-blocks.ts",
    "830-let-uninitialized.ts",
    "971-unions-switch.ts",
    "982-exceptions-rc-stress.ts",
    "983-exceptions-control-flow.ts",
    "987-exceptions-result-unions.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const nodeArgs = await nodeCorpusArgs(entryPath);
    const [node, rust] = await Promise.all([
      runToExit(process.execPath, nodeArgs),
      runToExit(result.binaryPath, [], {
        ...process.env,
        SCRIPTC_RUST_HEAP_AUDIT: "1",
      }),
    ]);
    expect(rust, fixture).toEqual(node);
  }
}, 120_000);

test("Rust dynamic prototype dispatch preserves array mutation and string conversion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-dyn-invoke-"));
  for (const fixture of [
    "2164-js-then-dyn-handler.cjs",
    "1122-any-captures.ts",
    "1591-js-closures.js",
    "1702-dyn-proto-dispatch.cjs",
    "1703-arguments-rest-props.cjs",
    "2036-evolving-array-decl.cjs",
    "2037-fn-decl-hoisting.cjs",
    "2038-evolving-array-js.cjs",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      runToExit(process.execPath, [entryPath]),
      runToExit(result.binaryPath, [], {
        ...process.env,
        SCRIPTC_RUST_HEAP_AUDIT: "1",
      }),
    ]);
    expect(rust, fixture).toEqual(node);
  }
}, 120_000);

test("Rust EventEmitter preserves dispatch, meta-events, limits, and identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-event-emitter-"));
  for (const fixture of [
    "1644-ee-basics.ts",
    "1646-ee-once-remove.ts",
    "1649-ee-names-counts.ts",
    "1650-ee-prepend.ts",
    "1652-ee-snapshot.ts",
    "1647-ee-meta-events.ts",
    "1651-ee-max-listeners.ts",
  ]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      runToExit(process.execPath, [entryPath]),
      runToExit(result.binaryPath, [], {
        ...process.env,
        SCRIPTC_RUST_HEAP_AUDIT: "1",
      }),
    ]);
    expect(rust, fixture).toEqual(node);
  }
}, 120_000);

test("Rust EventEmitter preserves unhandled errors, CJS identity, and the global listener limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-event-emitter-advanced-"));
  for (const fixture of ["1648-ee-error-event.ts", "1653-ee-cjs.cjs", "2321-emitter-static-setmax.cjs"]) {
    const entryPath = resolve("tests/corpus", fixture);
    const result = await compile(entryPath, {
      outDir: dir,
      outPath: join(dir, fixture.slice(0, -3)),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
    ).toBe(true);
    if (!result.ok) continue;
    const [node, rust] = await Promise.all([
      runToExit(process.execPath, [entryPath]),
      runToExit(result.binaryPath, [], {
        ...process.env,
        SCRIPTC_RUST_HEAP_AUDIT: "1",
      }),
    ]);
    if (fixture === "1648-ee-error-event.ts") {
      expect(rust.stdout, fixture).toBe(node.stdout);
      expect(rust.exitCode, fixture).toBe(node.exitCode);
      expect(rust.stderr, fixture).toContain("Uncaught Error: unhandled fatal");
      expect(rust.stderr, fixture).not.toContain("Rust heap object(s) still live");
    } else {
      expect(rust, fixture).toEqual(node);
    }
  }
}, 120_000);

test.each([
  "1645-ee-extends.ts",
  "1654-ee-namespace.ts",
])("Rust EventEmitter subclass preserves registry identity and hierarchy: %s", async (fixture) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-event-emitter-inheritance-"));
  const entryPath = resolve("tests/corpus", fixture);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, fixture.slice(0, -3)),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
  ).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  expect(rust, fixture).toEqual(node);
}, 240_000);

test.each([
  "2618-ee-emit-override.ts",
  "2619-ee-override-chain.ts",
  "2620-ee-override-once-order.ts",
  "2621-ee-override-error-throw.ts",
  "2622-ee-override-filter.ts",
  "2623-ee-job-queue.ts",
])("Rust EventEmitter subclass virtual override matches Node: %s", async (fixture) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-event-emitter-overrides-"));
  const entryPath = resolve("tests/corpus", fixture);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, fixture.slice(0, -3)),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
  ).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  if (fixture === "2621-ee-override-error-throw.ts") {
    expect(rust.stdout, fixture).toBe(node.stdout);
    expect(rust.exitCode, fixture).toBe(node.exitCode);
    expect(rust.stderr, fixture).toContain("Uncaught Error: second");
    expect(rust.stderr, fixture).not.toContain("Rust heap object(s) still live");
  } else {
    expect(rust, fixture).toEqual(node);
  }
}, 240_000);

test.each([
  "1677-emitter-listeners.ts",
  "1678-emitter-dyn-listeners.cjs",
  "2574-emitter-max-listeners-ladders.cjs",
  "2624-ee-override-js.cjs",
])("Rust EventEmitter preserves listener introspection and checked dynamic contracts: %s", async (fixture) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-event-emitter-dynamic-"));
  const entryPath = resolve("tests/corpus", fixture);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, fixture.replace(/\.(?:c?js|ts)$/, "")),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
  ).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  expect(rust, fixture).toEqual(node);
}, 240_000);

test.each([
  "1600-assert-passing.ts",
  "1602-assert-caught-error.ts",
  "1603-assert-scalar-messages.ts",
  "1604-assert-deep-structures.ts",
  "1605-assert-import-forms.ts",
  "1606-assert-strict-module.ts",
  "1607-assert-throws-match.ts",
  "1609-assert-async.ts",
  "1680-assert-bytes.ts",
  "1681-assert-funcs.ts",
  "1720-assert-throws-shape.ts",
  "1721-assert-throws-regex-class.ts",
  "1722-assert-rejects.ts",
  "1723-assert-does-not-reject.ts",
  "1724-assert-iferror.ts",
  "1725-assert-symbols.ts",
  "1770-assert-dyn-strict.ts",
  "1771-assert-dyn-deep.ts",
  "1772-assert-dyn-js.cjs",
  "2285-iferror-dyn.cjs",
  "2487-recursive-deep-equal.ts",
])("Rust assertions preserve static verdicts and Node messages: %s", async (fixture) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-assertions-"));
  const entryPath = resolve("tests/corpus", fixture);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, fixture.replace(/\.(?:c?js|ts)$/, "")),
    backend: "rust",
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : `${fixture}: ${result.diagnostics.map((diag) => diag.message).join("; ")}`,
  ).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  expect(rust, fixture).toEqual(node);
}, 240_000);

test.each([
  ["1601-assert-fail-exit.ts", "Expected values to be strictly equal:"],
  ["1727-assert-throws-shape-exit.ts", "Expected values to be strictly deep-equal:"],
  ["1773-assert-dyn-exit.ts", "Expected values to be strictly equal:"],
])("Rust uncaught AssertionError preserves stdout, exit status, and heap cleanup: %s", async (fixture, message) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-assertion-exit-"));
  const entryPath = resolve("tests/corpus", fixture);
  const result = await compile(entryPath, {
    outDir: dir,
    outPath: join(dir, fixture.replace(/\.ts$/, "")),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok, result.ok ? fixture : result.diagnostics.map((diag) => diag.message).join("; ")).toBe(true);
  if (!result.ok) return;
  const [node, rust] = await Promise.all([
    runToExit(process.execPath, [entryPath]),
    runToExit(result.binaryPath, [], {
      ...process.env,
      SCRIPTC_RUST_HEAP_AUDIT: "1",
    }),
  ]);
  expect(rust.stdout).toBe(node.stdout);
  expect(rust.exitCode).toBe(node.exitCode);
  expect(rust.stderr).toContain(`Uncaught AssertionError [ERR_ASSERTION]: ${message}`);
  expect(rust.stderr).not.toContain("Rust heap object(s) still live");
}, 240_000);
