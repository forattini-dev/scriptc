import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { compileRust } from "../src/backend/rust/compile.js";
import { emitRustModule } from "../src/backend/rust/emitter.js";
import { validateModule } from "../src/ir/validate.js";
import { fibModule } from "./fixtures/fib-ir.js";

const execFileAsync = promisify(execFile);

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
    "101-arithmetic.ts",
    "102-comparisons.ts",
    "103-ternary.ts",
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
    "970-unions-basics.ts",
    "975-unions-undefined.ts",
    "980-exceptions-basics.ts",
    "984-exceptions-finally.ts",
    "1366-union-equality.ts",
    "2482-recursive-union-tree.ts",
    "2483-recursive-record-cycles.ts",
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
}, 120_000);

test("unsupported Rust IR refuses instead of falling back to C or LLVM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-refusal-"));
  const sourcePath = join(dir, "unsupported.ts");
  await writeFile(sourcePath, "console.log([1, 2, 3].slice(1));\n");
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

test("Rust synchronous text filesystem operations match Node and throw catchably", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-fs-sync-"));
  for (const fixture of [
    "992-fs-roundtrip.ts",
    "993-fs-readdir.ts",
    "994-fs-errors.ts",
    "1006-json-fs-config.ts",
    "1520-fs-wider-surface.ts",
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
import { realpathSync } from "node:fs";
console.log(realpathSync(".") === process.cwd());
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
