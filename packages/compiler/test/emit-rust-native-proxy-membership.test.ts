import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const run = promisify(execFile);

test("native shared membership preserves ordinary own keys and refuses Proxy without Get", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-native-proxy-membership-"));
  try {
    const entry = join(directory, "main.ts");
    await writeFile(entry, `
type View = { known: number; explicit?: number; absent?: number };
type Indexed = { known: number; [key: string]: unknown };
function computed(value: Indexed, key: string): boolean { return key in value; }
function dynamicComputed(value: any, key: string): boolean { return key in value; }
function report(label: string, probe: () => boolean): void {
  try { console.log(label, probe()); }
  catch (error) {
    if (error instanceof Error) console.log(label, error.message);
    else console.log(label, "unexpected");
  }
}
const original = { known: 1, explicit: undefined as number | undefined };
const raw: unknown = original;
const ordinary = raw as View;
const ordinaryIndexed = raw as Indexed;
const alias: any = original;
alias.extra = 7;
console.log("ordinary-in", "known" in ordinary, "explicit" in ordinary, "absent" in ordinary, "extra" in ordinary);
console.log("ordinary-own", Object.hasOwn(ordinary, "explicit"), Object.hasOwn(ordinary, "absent"), Object.hasOwn(ordinary, "extra"));
console.log("ordinary-legacy", Object.prototype.hasOwnProperty.call(ordinary, "explicit"), Object.prototype.hasOwnProperty.call(ordinary, "absent"));
console.log("ordinary-computed", computed(ordinaryIndexed, "known"), computed(ordinaryIndexed, "explicit"), computed(ordinaryIndexed, "absent"), computed(ordinaryIndexed, "extra"));

let getCalls = 0;
const proxy = new Proxy(original, { get() { getCalls++; return 1; } });
const view = proxy as unknown as View;
const indexed = proxy as unknown as Indexed;
const dynamic: any = proxy;
console.log("proxy-casts", getCalls);
report("declared", () => "known" in view);
report("optional", () => "explicit" in view);
report("missing", () => "absent" in view);
report("extra", () => "extra" in view);
report("computed", () => computed(indexed, "known"));
report("computed-missing", () => computed(indexed, "absent"));
report("own", () => Object.hasOwn(view, "explicit"));
report("legacy", () => Object.prototype.hasOwnProperty.call(view, "explicit"));
report("dynamic", () => "known" in dynamic);
report("dynamic-computed", () => dynamicComputed(dynamic, "known"));
console.log("get-calls", getCalls);
export {};
`);
    const result = await compile(entry, {
      backend: "rust", allowEngine: false, target: "node24", optimization: "dev",
      outDir: directory, outPath: join(directory, "program"),
    });
    expect(result.ok, result.ok ? entry : JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toEqual({ engine: "none", externalFfi: false });
    expect(result.runtimeFences).toEqual([]);
    const [node, rust] = await Promise.all([
      run(nodeOracleExecutable(), [entry], { timeout: 10_000 }),
      run(result.binaryPath, [], { timeout: 10_000, env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } }),
    ]);
    const ordinary = [
      "ordinary-in true true false true",
      "ordinary-own true false true",
      "ordinary-legacy true false",
      "ordinary-computed true true false true",
      "proxy-casts 0",
    ];
    expect(node.stdout).toBe([
      ...ordinary, "declared true", "optional true", "missing false", "extra true",
      "computed true", "computed-missing false", "own true", "legacy true",
      "dynamic true", "dynamic-computed true", "get-calls 0", "",
    ].join("\n"));
    // Membership is outside the current native Proxy slice. This acceptance
    // test pins an explicit refusal; it is deliberately not a Node-equality
    // corpus program. Neither implementation should invoke the Get trap.
    const refusal = (label: string, own = false) => `${label} scriptc: ${own ? "own property membership" : "property membership"} on native Proxy objects is not supported yet`;
    expect(rust.stdout).toBe([
      ...ordinary, refusal("declared"), refusal("optional"), refusal("missing"), refusal("extra"),
      refusal("computed"), refusal("computed-missing"), refusal("own", true), refusal("legacy", true),
      refusal("dynamic"), refusal("dynamic-computed"), "get-calls 0", "",
    ].join("\n"));
    expect(node.stderr).toBe("");
    expect(rust.stderr).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
