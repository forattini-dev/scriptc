import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program.js";
import { prunedNpmStaticModules, type NpmStaticPrunedPackage } from "./npm-static-prune.js";

const fixtureRoot = join(import.meta.dirname, "../../../../tests/fixtures/npm-static");

interface Plan {
  files: string[];
  /** The executable frontier: the module order plus literal dynamic
   * imports and fork targets. */
  runtimeFiles: string[];
  diagnostics: string[];
  pruned: readonly NpmStaticPrunedPackage[];
}

function moduleOrder(entry: string, packages: string | string[]): Plan {
  const load = loadProgram(join(fixtureRoot, entry), { npmStatic: typeof packages === "string" ? [packages] : packages });
  try {
    const diagnostics = checkPreflight(load);
    return {
      files: load.moduleOrder.map((sf) => sf.fileName),
      runtimeFiles: load.runtimeFiles.map((sf) => sf.fileName),
      diagnostics: diagnostics.map((d) => d.code),
      pruned: prunedNpmStaticModules(load.program),
    };
  } finally {
    load.dispose();
  }
}

/** The namedbarrel package files in the module order, relative to the
 * package root. */
function barrelModules(plan: Plan, files: readonly string[] = plan.files): string[] {
  const marker = "/node_modules/namedbarrel/";
  return files.filter((file) => file.includes(marker)).map((file) => file.slice(file.indexOf(marker) + marker.length)).sort();
}

/** Every demand of the barrel evaluates these: its own import edge
 * (kept.js), the empty re-export clause (effect.js) and the CommonJS star
 * target whose export names are not enumerable (legacy.cjs). */
const ALWAYS_EVALUATED = ["effect.js", "index.js", "kept.js", "legacy.cjs"];
const sorted = (modules: readonly string[]): string[] => [...modules].sort();

describe("npm static namespace re-export pruning", () => {
  test("the named package's sideEffects declaration skips unused namespace exports through a nested ESM scope", () => {
    const { files, diagnostics, pruned } = moduleOrder("purebarrel-cli.ts", "purebarrel");
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/purebarrel/dist/esm/feature.js"))).toBe(true);
    expect(files.some((file) => file.endsWith("/purebarrel/dist/esm/spare.js"))).toBe(false);
    expect(pruned).toEqual([{ package: "purebarrel", modules: ["dist/esm/spare.js"] }]);
  });

  test("a requested namespace retains its module edge and its preflight fence", () => {
    const { files, diagnostics, pruned } = moduleOrder("purebarrel-spare-cli.ts", "purebarrel");
    expect(files.some((file) => file.endsWith("/purebarrel/dist/esm/spare.js"))).toBe(true);
    expect(diagnostics).toContain("SC1014");
    expect(pruned).toEqual([{ package: "purebarrel", modules: ["dist/esm/feature.js"] }]);
  });

  test("a package without sideEffects metadata retains unused module initialization", () => {
    const { files, diagnostics, pruned } = moduleOrder("statefulbarrel-cli.ts", "statefulbarrel");
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/statefulbarrel/spare.js"))).toBe(true);
    expect(pruned).toEqual([]);
  });

  test("an empty named import still requests module initialization", () => {
    const { files, diagnostics } = moduleOrder("statefulbarrel-empty-cli.ts", "statefulbarrel");
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/statefulbarrel/index.js"))).toBe(true);
    expect(files.some((file) => file.endsWith("/statefulbarrel/spare.js"))).toBe(true);
  });

  test("a dependency cycle inherits an impure sibling before pruning a namespace re-export", () => {
    const { files, diagnostics, pruned } = moduleOrder("cycle-cli.ts", ["cycle-a", "cycle-b", "cycle-impure"]);
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/cycle-b/spare.js"))).toBe(true);
    expect(files.some((file) => file.endsWith("/cycle-impure/index.js"))).toBe(true);
    expect(pruned).toEqual([]);
  });
});

describe("npm static named re-export pruning", () => {
  test("a named import admits its module and the barrel's import edges, not the package", () => {
    const plan = moduleOrder("namedbarrel-alpha-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted(["alpha.js", ...ALWAYS_EVALUATED, "pair.js"]));
  });

  test("an aliased name passes through under the target's spelling and narrows the sub-barrel", () => {
    const plan = moduleOrder("namedbarrel-renamed-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted(["beta.js", ...ALWAYS_EVALUATED, "pair.js"]));
  });

  test("`export { default as name } from` follows the target's default", () => {
    const plan = moduleOrder("namedbarrel-gamma-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted([...ALWAYS_EVALUATED, "gamma.js"]));
  });

  test("`export { default } from` follows a default import alone", () => {
    const plan = moduleOrder("namedbarrel-default-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted([...ALWAYS_EVALUATED, "main-default.js"]));
  });

  test("a re-export chain narrows at every hop", () => {
    const plan = moduleOrder("namedbarrel-chained-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted(["chain/index.js", "chain/leaf.js", ...ALWAYS_EVALUATED]));
  });

  test("`export * from` is followed by name when the target's export names are syntactically known", () => {
    // star/index.js declares `starred` itself; its own nested star to
    // inner.js is pruned in turn.
    const plan = moduleOrder("namedbarrel-starred-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted([...ALWAYS_EVALUATED, "star/index.js"]));
  });

  test("a name provided through nested stars admits the star chain", () => {
    const plan = moduleOrder("namedbarrel-starred-inner-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted([...ALWAYS_EVALUATED, "star/index.js", "star/inner.js"]));
  });

  test("a CommonJS star target has no enumerable export names and keeps today's whole-module edge", () => {
    const plan = moduleOrder("namedbarrel-alpha-cli.ts", "namedbarrel");
    expect(barrelModules(plan)).toContain("legacy.cjs");
  });

  test("an empty re-export clause is an evaluation request, never pruned", () => {
    const plan = moduleOrder("namedbarrel-alpha-cli.ts", "namedbarrel");
    expect(barrelModules(plan)).toContain("effect.js");
  });

  test("a demanded module keeps its edge and its fence", () => {
    const plan = moduleOrder("namedbarrel-unused-cli.ts", "namedbarrel");
    expect(barrelModules(plan)).toEqual(sorted([...ALWAYS_EVALUATED, "unused.js"]));
    expect(plan.diagnostics).toContain("SC1014");
  });

  // A namespace import demands every export of the barrel, so each of its
  // re-export statements is followed; the names still pass through, so a
  // sub-barrel's export the namespace cannot reach (chain/other.js behind
  // `export { chained } from "./chain/index.js"`) stays pruned.
  const WHOLE_BARREL = sorted([
    "alpha.js", "beta.js", "chain/index.js", "chain/leaf.js", ...ALWAYS_EVALUATED,
    "gamma.js", "main-default.js", "pair.js", "star/index.js", "star/inner.js", "star/unused.js", "tools.js", "unused.js",
  ]);

  test("a namespace import follows every re-export of the barrel", () => {
    const plan = moduleOrder("namedbarrel-namespace-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toContain("SC1014");
    expect(barrelModules(plan)).toEqual(WHOLE_BARREL);
    expect(plan.pruned).toEqual([{ package: "namedbarrel", modules: ["chain/other.js"] }]);
  });

  test("a dynamic import follows every re-export of the barrel", () => {
    const plan = moduleOrder("namedbarrel-dynamic-cli.ts", "namedbarrel");
    expect(barrelModules(plan)).toEqual([]);
    expect(barrelModules(plan, plan.runtimeFiles)).toEqual(WHOLE_BARREL);
    expect(plan.pruned).toEqual([{ package: "namedbarrel", modules: ["chain/other.js"] }]);
  });

  test("a project module's named re-export passes its name into the package", () => {
    const plan = moduleOrder("namedbarrel-reexport-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted([...ALWAYS_EVALUATED, "gamma.js"]));
  });

  test("demand from several importers is the union of their names", () => {
    const plan = moduleOrder("namedbarrel-two-cli.ts", "namedbarrel");
    expect(plan.diagnostics).toEqual([]);
    expect(barrelModules(plan)).toEqual(sorted(["alpha.js", "chain/index.js", "chain/leaf.js", ...ALWAYS_EVALUATED, "pair.js"]));
  });

  test("the plan reports every module only pruned edges reach, per package", () => {
    const plan = moduleOrder("namedbarrel-alpha-cli.ts", "namedbarrel");
    expect(plan.pruned).toEqual([{
      package: "namedbarrel",
      modules: [
        "beta.js", "chain/index.js", "chain/leaf.js", "chain/other.js", "gamma.js", "main-default.js",
        "star/index.js", "star/inner.js", "star/unused.js", "tools.js", "unused.js",
      ],
    }]);
  });

  test("a package without sideEffects metadata follows every named and star re-export", () => {
    const plan = moduleOrder("statefulnamed-cli.ts", "statefulnamed");
    expect(plan.diagnostics).toEqual([]);
    expect(plan.files.some((file) => file.endsWith("/statefulnamed/unused.js"))).toBe(true);
    expect(plan.files.some((file) => file.endsWith("/statefulnamed/star.js"))).toBe(true);
    expect(plan.pruned).toEqual([]);
  });

  test("a sideEffects-free package with an impure dependency follows every named re-export", () => {
    const plan = moduleOrder("impurenamed-cli.ts", ["impurenamed", "cycle-impure"]);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.files.some((file) => file.endsWith("/impurenamed/unused.js"))).toBe(true);
    expect(plan.files.some((file) => file.endsWith("/cycle-impure/index.js"))).toBe(true);
    expect(plan.pruned).toEqual([]);
  });
});
