import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";
import { nodeOracleExecutable } from "./oracle-environment.js";

function packageAt(dir: string, name: string, source: string, declaration: string, main = "index.js"): string {
  const pkg = join(dir, "node_modules", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, type: "module", main, types: "index.d.ts" }));
  writeFileSync(join(pkg, main), source);
  writeFileSync(join(pkg, "index.d.ts"), declaration);
  return pkg;
}

async function fixture(run: (dir: string, entry: string, root: string, child: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-transitive-"));
  try {
    const root = packageAt(dir, "parent", 'import { base } from "child";\nexport function run() { return base() + 1; }\n',
      "export declare function run(): number;");
    const child = packageAt(root, "child", 'import { leaf } from "leaf";\nexport function base() { return leaf(); }\n', "export declare function base(): number;");
    packageAt(child, "leaf", "export function leaf() { return 7; }\n", "export declare function leaf(): number;");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, 'import { run } from "parent"; console.log(run()); console.error("transitive");');
    await run(dir, entry, root, child);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("auto discovers nested transitive imports to a fixed point", async () => {
  await fixture((_, entry) => {
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.npmStatic).toEqual(expect.arrayContaining(
      ["parent", "child", "leaf"].map((name) => ({ package: name, status: "static" })),
    ));
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.stats.statementsIsland).toBe(0);
  });
});

test.for(["rust", "c", "llvm"] as const)("transitive auto native parity with backend %s", async (backend) => {
  await fixture(async (dir, entry) => {
    const result = await compile(entry, { npmStatic: "auto", backend, allowEngine: false,
      outDir: join(dir, "out"), outPath: join(dir, "out/program"), optimization: "dev",
      sanitize: backend !== "rust" && process.env["SCRIPTC_SAN"] === "1",
    });
    expect(result.ok, result.ok ? "" : result.diagnostics.map((d) => d.message).join("\n")).toBe(true);
    if (!result.ok) return;
    expect(result.execution.engine).toBe("none");
    const node = spawnSync(nodeOracleExecutable(), [entry], { timeout: 30_000 });
    const native = spawnSync(result.binaryPath, [], { timeout: 30_000 });
    expect(node.error).toBeUndefined();
    expect(native.error).toBeUndefined();
    expect(node.status).toBe(0);
    expect(native.signal).toBeNull();
    expect(native.status).toBe(node.status);
    expect(native.stdout).toEqual(node.stdout);
    expect(native.stderr).toEqual(node.stderr);
  });
});

test("explicit opt-in still selects only the named packages", async () => {
  await fixture((_, entry) => {
    const { coverage } = analyze(entry, { npmStatic: ["parent"], backend: "rust", allowEngine: false });
    expect(coverage.npmStatic).toEqual([{ package: "parent", status: "static" }]);
    expect(coverage.diagnostics.some((d) => d.code === "SC2013" && d.message.includes("child"))).toBe(true);
  });
});

test("auto does not re-admit a transitive external host mapping", async () => {
  await fixture((dir, entry) => {
    const declaration = join(dir, "child-host.d.ts");
    writeFileSync(declaration, "export declare function base(): number;");
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false,
      externalTypes: { child: declaration },
    });
    expect(coverage.npmStatic?.some((s) => s.package === "child" && s.status === "static")).toBe(false);
    expect(coverage.npmStatic).toContainEqual(expect.objectContaining({ package: "parent", status: "fallback" }));
    expect(coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(true);
  });
});

test("auto discovers a dependency named only by a transitive reexport", async () => {
  await fixture((_, entry, __, child) => {
    writeFileSync(join(child, "index.js"), 'export { leaf as base } from "leaf";\n');
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.npmStatic).toEqual(expect.arrayContaining(
      ["parent", "child", "leaf"].map((name) => ({ package: name, status: "static" })),
    ));
    expect(coverage.preflightFailed).toBe(false);
    // Discovery is independent of the existing cross-package reexport
    // binding limitation; --no-engine must still refuse that driven path.
    expect(coverage.diagnostics.some((d) => d.code === "SC3003" && d.message.includes("binding form with no lowering"))).toBe(true);
  });
});

test("auto discovers top-level requires in a selected CommonJS package", async () => {
  await fixture((_, entry, root) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "parent", main: "index.cjs", types: "index.d.ts" }));
    writeFileSync(join(root, "index.cjs"), 'const child = require("child");\nexports.run = function () { return child.base() + 1; };\n');
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.npmStatic).toEqual(expect.arrayContaining(
      ["parent", "child", "leaf"].map((name) => ({ package: name, status: "static" })),
    ));
    expect(coverage.diagnostics).toEqual([]);
  });
});

test("cyclic package imports are judged once and terminate", async () => {
  await fixture((_, entry, __, child) => {
    writeFileSync(join(child, "index.js"), 'import "parent";\nexport function base() { return 7; }\n');
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.npmStatic).toHaveLength(2);
    expect(coverage.npmStatic).toEqual(expect.arrayContaining(
      ["parent", "child"].map((name) => ({ package: name, status: "static" })),
    ));
    expect(coverage.diagnostics).toEqual([]);
  });
});

test("an ineligible transitive package records one refusal", async () => {
  await fixture((_, entry, __, child) => {
    writeFileSync(join(child, "index.js"), "export function base(){return 7;}");
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    const statuses = coverage.npmStatic?.filter((s) => s.package === "child");
    expect(statuses).toHaveLength(1);
    expect(statuses?.[0]?.status).toBe("fallback");
    expect(coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(true);
  });
});

test("an external subpath prevents transitive admission of its whole package", async () => {
  await fixture((dir, entry) => {
    const declaration = join(dir, "host.d.ts");
    writeFileSync(declaration, "export declare function host(): void;");
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false,
      externalTypes: { "child/host": declaration },
    });
    expect(coverage.npmStatic).toContainEqual({ package: "child", status: "fallback",
      detail: 'mapped as an external host module by --external-types ("child/host")',
    });
    expect(coverage.npmStatic?.some((s) => s.package === "child" && s.status === "static")).toBe(false);
    expect(coverage.diagnostics.some((d) => d.code === "SC2013")).toBe(true);
  });
});

test("an unrelated surface failure does not discard packages that typecheck together", async () => {
  await fixture((dir, entry, _, child) => {
    // The parent infers number only with its child selected. Probing the
    // parent SOLO trusts this deliberately wrong declaration and blames it.
    writeFileSync(join(child, "index.d.ts"), "export declare function base(): string;");
    packageAt(dir, "guard", "export function isText(value) { return Boolean(value); }\n",
      "export declare function isText(value: unknown): value is string;");
    writeFileSync(entry, `
      import { run } from "parent";
      import { isText } from "guard";
      const n: number = run();
      function render(value: unknown): string { return isText(value) ? value.toUpperCase() : ""; }
      console.log(n, render("value"));
    `);
    const { coverage } = analyze(entry, { npmStatic: "auto", backend: "rust", allowEngine: false });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.npmStatic).toEqual(expect.arrayContaining(
      ["parent", "child", "leaf"].map((name) => ({ package: name, status: "static" })),
    ));
    expect(coverage.npmStatic).toContainEqual(expect.objectContaining({ package: "guard", status: "fallback" }));
  });
});
