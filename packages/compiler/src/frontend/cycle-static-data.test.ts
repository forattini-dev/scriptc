import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import * as ts from "./ts7/adapter.js";
import { ambientDtsPath, fallbackDtsPath } from "./program.js";
import { externalStaticDataPropertyInitializer } from "./cycle-static-data.js";

interface FixtureWorld {
  dir: string;
  files: string[];
  program: ts.Ts7Program;
  checker: ts.TypeChecker;
}

let world: FixtureWorld | null = null;

afterAll(() => {
  world?.program.dispose();
  if (world !== null) rmSync(world.dir, { recursive: true, force: true });
});

function fixtureWorld(): FixtureWorld {
  if (world !== null) return world;
  const sources = {
    "registry.ts": `
const MIB = 1024 * 1024;
const TARGET = 0.5;
const OTHER = { skipped: 1 };
export const TABLE = {
  events: { maxBytes: 4 * MIB, targetRatio: TARGET },
  get live() { return Date.now(); },
  ...OTHER,
} as const;
`,
    "consumer.ts": `
import { TABLE } from "./registry.ts";
const dynamicKey = "events";
export const maxBytes = TABLE.events.maxBytes;
export const targetRatio = TABLE["events"].targetRatio;
export const getter = TABLE.live;
export const spread = TABLE.skipped;
export const dynamic = TABLE[dynamicKey].maxBytes;
`,
  };
  const dir = mkdtempSync(join(tmpdir(), "scriptc-static-data-"));
  const files = Object.entries(sources).map(([name, source]) => {
    const file = join(dir, name);
    writeFileSync(file, source);
    return file;
  });
  const program = ts.createProgram(
    [...files, ambientDtsPath(), fallbackDtsPath()],
    {
      strict: true,
      target: ts.ScriptTarget.ESNext as number,
      module: ts.ModuleKind.ESNext as number,
      moduleResolution: ts.ModuleResolutionKind.Bundler as number,
      lib: ["lib.es2023.d.ts"],
      types: [],
      allowImportingTsExtensions: true,
      noEmit: true,
    },
  );
  world = { dir, files, program, checker: program.getTypeChecker() };
  return world;
}

function initializerFor(exportedName: string): ts.Expression | null {
  const fixture = fixtureWorld();
  const consumer = fixture.program.getSourceFile(
    fixture.files.find((file) => file.endsWith("consumer.ts"))!,
  )!;
  const statement = consumer.statements.find(
    (candidate): candidate is ts.VariableStatement =>
      ts.isVariableStatement(candidate) &&
      ts.isIdentifier(candidate.declarationList.declarations[0]!.name) &&
      candidate.declarationList.declarations[0]!.name.text === exportedName,
  );
  const expression = statement?.declarationList.declarations[0]?.initializer;
  if (expression === undefined) throw new Error(`missing fixture expression ${exportedName}`);
  return externalStaticDataPropertyInitializer(fixture.checker, expression);
}

test("finds exact leaves in an imported const data table", () => {
  expect(initializerFor("maxBytes")?.getText()).toBe("4 * MIB");
  expect(initializerFor("targetRatio")?.getText()).toBe("TARGET");
});

test("rejects getters, spreads, and dynamic keys", () => {
  expect(initializerFor("getter")).toBeNull();
  expect(initializerFor("spread")).toBeNull();
  expect(initializerFor("dynamic")).toBeNull();
});
