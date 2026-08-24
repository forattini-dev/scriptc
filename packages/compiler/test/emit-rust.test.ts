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
    "600-closures-basic.ts",
    "601-closures-loops.ts",
    "602-closures-identity-recursion.ts",
    "603-closures-rc-stress.ts",
    "604-closures-for-of.ts",
    "605-closures-forward-capture-tdz.ts",
    "750-cycle-closure-box.ts",
    "751-cycle-records-mutual.ts",
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
  await writeFile(sourcePath, "console.log([1, 2, 3].includes(2));\n");
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
