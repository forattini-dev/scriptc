import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "../src/frontend/program.js";

const directories: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-project-types-"));
  directories.push(dir);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("adopts included ambient declarations without admitting unrelated executable roots", () => {
  const dir = fixture({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*"], exclude: ["src/excluded"] }),
    "src/main.ts": "const answer: LocalAnswer = 42; console.log(answer);\n",
    "src/types.d.ts": "type LocalAnswer = number;\n",
    "src/unused.ts": "const incorrect: number = 'must not be a compiler root';\n",
    "src/excluded/conflict.d.ts": "type LocalAnswer = string;\n",
  });
  const load = loadProgram(join(dir, "src/main.ts"));
  try {
    expect(checkPreflight(load)).toEqual([]);
    expect(load.program.getSourceFile(join(dir, "src/types.d.ts"))).toBeDefined();
    expect(load.program.getSourceFile(join(dir, "src/unused.ts"))).toBeUndefined();
    expect(load.program.getSourceFile(join(dir, "src/excluded/conflict.d.ts"))).toBeUndefined();
    expect(load.moduleOrder.map(file => file.fileName)).not.toContain(join(dir, "src/unused.ts"));
  } finally { load.dispose(); }
});

test("inherits declaration files through extends and follows their type references", () => {
  const dir = fixture({
    "config/base.json": JSON.stringify({ compilerOptions: { strict: true }, files: ["../types/index.d.ts"] }),
    "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
    "types/index.d.ts": '/// <reference path="./number.d.ts" />\n',
    "types/number.d.ts": "type LocalAnswer = number;\n",
    "main.ts": "const answer: LocalAnswer = 42; console.log(answer);\n",
  });
  const load = loadProgram(join(dir, "main.ts"));
  try { expect(checkPreflight(load)).toEqual([]); }
  finally { load.dispose(); }
});

test("loads declarations from the config of an imported workspace source", () => {
  const dir = fixture({
    "app/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    "app/main.ts": 'import { answer } from "../shared/value.ts"; console.log(answer);\n',
    "shared/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts", "types/*.d.ts"] }),
    "shared/types/index.d.ts": "type SharedAnswer = number;\n",
    "shared/value.ts": "export const answer: SharedAnswer = 42;\n",
    "unrelated/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["*.d.ts"] }),
    "unrelated/conflict.d.ts": "type SharedAnswer = string;\n",
  });
  const load = loadProgram(join(dir, "app/main.ts"));
  try {
    expect(checkPreflight(load)).toEqual([]);
    expect(load.program.getSourceFile(join(dir, "unrelated/conflict.d.ts"))).toBeUndefined();
  } finally { load.dispose(); }
});

test("npm-static preserves configured ambient roots of a workspace without reviving runtime twins", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ type: "module" }),
    "app/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, files: ["main.ts"] }),
    "app/main.ts": 'import { answer } from "configured-workspace"; const value: number = answer; console.log(value);',
    "shared/package.json": JSON.stringify({ name: "configured-workspace", type: "module", exports: "./value.ts" }),
    "shared/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, files: ["types.d.ts", "value.d.ts", "value.ts"] }),
    "shared/types.d.ts": "type WorkspaceAnswer = number;",
    "shared/value.d.ts": "export declare const answer: string;",
    "shared/value.ts": "export const answer: WorkspaceAnswer = 42;",
  });
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(join(dir, "shared"), join(dir, "node_modules/configured-workspace"), "junction");
  const entry = join(dir, "app/main.ts");
  const load = loadProgram(entry, { npmStatic: ["configured-workspace"] });
  try {
    expect(checkPreflight(load)).toEqual([]);
    expect(load.program.getSourceFile(join(dir, "shared/types.d.ts"))).toBeDefined();
    expect(load.program.getSourceFile(join(dir, "shared/value.d.ts"))).toBeUndefined();
    expect(load.moduleOrder.some(sf => sf.fileName === join(dir, "shared/value.ts"))).toBe(true);
  } finally { load.dispose(); }
  writeFileSync(entry, 'import "configured-workspace"; const value: WorkspaceAnswer = "wrong"; console.log(value);');
  const invalid = loadProgram(entry, { npmStatic: ["configured-workspace"] });
  try {
    expect(checkPreflight(invalid)).toContainEqual(expect.objectContaining({
      code: "SC0001", message: "Type 'string' is not assignable to type 'number'.",
    }));
  } finally { invalid.dispose(); }
});

test("ambient declarations constrain actual use rather than suppressing errors", () => {
  const dir = fixture({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, files: ["types.d.ts", "main.ts"] }),
    "types.d.ts": "type LocalAnswer = number;\n",
    "main.ts": "const answer: LocalAnswer = 'wrong'; console.log(answer);\n",
  });
  const load = loadProgram(join(dir, "main.ts"));
  try { expect(checkPreflight(load).some(d => d.code === "SC0001" && d.message.includes("not assignable"))).toBe(true); }
  finally { load.dispose(); }
});

test("project references contribute declarations, not sibling executable roots", () => {
  const dir = fixture({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, files: [], references: [{ path: "./shared" }] }),
    "main.ts": "const answer: SharedAnswer = 42; console.log(answer);\n",
    "shared/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, files: ["types.d.ts", "unused.ts"], references: [{ path: ".." }] }),
    "shared/types.d.ts": "type SharedAnswer = number;\n",
    "shared/unused.ts": "const invalid: number = 'not an executable root';\n",
  });
  const load = loadProgram(join(dir, "main.ts"));
  try {
    expect(checkPreflight(load)).toEqual([]);
    expect(load.program.getSourceFile(join(dir, "shared/unused.ts"))).toBeUndefined();
  } finally { load.dispose(); }
});


test("adopts explicit types through inherited custom typeRoots", () => {
  const dir = fixture({
    "config/base.json": JSON.stringify({ compilerOptions: { strict: true, types: ["local-env"], typeRoots: ["../typings"] } }),
    "tsconfig.json": JSON.stringify({ extends: "./config/base.json", files: ["main.ts"] }),
    "typings/local-env/index.d.ts": "type CustomAnswer = number;\n",
    "typings/excluded/index.d.ts": "type CustomAnswer = string;\n",
    "main.ts": "const answer: CustomAnswer = 42; console.log(answer);\n",
  });
  const load = loadProgram(join(dir, "main.ts"));
  try {
    expect(checkPreflight(load)).toEqual([]);
    expect(load.program.getSourceFile(join(dir, "typings/excluded/index.d.ts"))).toBeUndefined();
  } finally { load.dispose(); }
});

test("configured runtime twins still use their JS bodies", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ name: "project-types-fixture", type: "module" }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    "helper.d.ts": "export declare function value(): string;\n",
    "helper.js": "export function value() { return 42; }\n",
    "main.ts": 'import { value } from "./helper.js"; const answer: number = value(); console.log(answer);\n',
  });
  const load = loadProgram(join(dir, "main.ts"));
  try {
    expect(checkPreflight(load)).toEqual([]);
    expect(load.moduleOrder.some(sf => sf.fileName === join(dir, "helper.js"))).toBe(true);
  } finally { load.dispose(); }
});
