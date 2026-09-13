import { archive, fixture, registry, registryPackages } from "./fixtures.js";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { prepareTypeAcquisition } from "./acquire.js";
import { discoverMissingTypes } from "./discovery.js";
import { withDeclarationOverlay } from "./context.js";
import { checkPreflight, loadProgram } from "../frontend/program.js";
import { declarationFiles, verifyIntegrity } from "./archive.js";

function preflight(root: string): string[] {
  const load = loadProgram(join(root, "main.ts"));
  try { return checkPreflight(load).map(d => d.message); }
  finally { load.dispose(); }
}

test("discovers the actual missing import, downloads and uses its declarations without touching the install", async () => {
  const root = fixture();
  const calls = registry();
  expect(discoverMissingTypes(join(root, "main.ts"), root, []).map(r => r.specifier)).toEqual(["type-example"]);
  const before = readFileSync(join(root, "package.json"), "utf8");
  const overlay = await prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir: join(root, "cache") });
  expect(calls).toHaveBeenCalledTimes(2);
  expect(withDeclarationOverlay(overlay, () => preflight(root))).toEqual([]);
  expect([...overlay.files.keys()].some(path => path.endsWith("postinstall.js"))).toBe(false);
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  expect(preflight(root).some(message => message.includes("declaration file"))).toBe(true);
});

test("offline replay and frozen lock use pinned bytes without network", async () => {
  const root = fixture();
  const calls = registry();
  const opts = { cacheDir: join(root, "cache") };
  await prepareTypeAcquisition(join(root, "main.ts"), { ...opts, mode: "auto" });
  const lock = readFileSync(join(root, "scriptc.types.lock.json"), "utf8");
  calls.mockClear();
  const overlay = await prepareTypeAcquisition(join(root, "main.ts"), { ...opts, mode: "offline", frozenLock: true });
  expect(calls).not.toHaveBeenCalled();
  expect(withDeclarationOverlay(overlay, () => preflight(root))).toEqual([]);
  expect(readFileSync(join(root, "scriptc.types.lock.json"), "utf8")).toBe(lock);
  writeFileSync(join(root, "node_modules/type-example/package.json"), JSON.stringify({ name: "type-example", version: "2.0.0", main: "index.js", type: "module" }));
  await expect(prepareTypeAcquisition(join(root, "main.ts"), { ...opts, mode: "auto", frozenLock: true })).rejects.toThrow("lock miss");
  expect(calls).not.toHaveBeenCalled();
});

test("a package root declaration does not cover a missing subpath", async () => {
  const root = fixture({
    "main.ts": 'import { answer } from "type-example/wrapper"; console.log(answer());\n',
    "node_modules/type-example/wrapper.js": "export function answer() { return 42; }\n",
  });
  registry();
  await expect(prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir: join(root, "cache") })).rejects.toThrow("exact subpath");
});

test("downloaded types constrain real usage and never become host externalTypes", async () => {
  const root = fixture({ "main.ts": 'import { answer } from "type-example"; const wrong: string = answer(); console.log(wrong);\n' });
  registry();
  const overlay = await prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir: join(root, "cache") });
  withDeclarationOverlay(overlay, () => {
    const load = loadProgram(join(root, "main.ts"));
    try {
      expect(load.externalTypes.size).toBe(0);
      expect(checkPreflight(load).some(d => d.message.includes("not assignable"))).toBe(true);
    } finally { load.dispose(); }
  });
});

test("archive boundaries reject tampering and path traversal", () => {
  expect(() => verifyIntegrity(Buffer.from("wrong"), "sha512-AAAA")).toThrow("integrity mismatch");
  expect(() => declarationFiles(archive({ "../escape.d.ts": "", "package.json": "{}" }))).toThrow("unsafe");
});


test("TS7 resolves typesVersions and declaration subpath graphs", async () => {
  const root = fixture({
    "main.ts": 'import { answer } from "type-example/sub"; const n: number = answer(); console.log(n);\n',
    "node_modules/type-example/sub.js": "export function answer() { return 42; }\n",
  });
  registry({
    "v5/sub.d.ts": 'export { answer } from "./shared.js";\n',
    "v5/shared.d.ts": "export function answer(): number;\n",
    "sub.d.ts": "export function answer(): string;\n",
  }, { typesVersions: { ">=5": { "*": ["v5/*"] } } });
  const overlay = await prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir: join(root, "cache") });
  expect(withDeclarationOverlay(overlay, () => preflight(root))).toEqual([]);
  expect([...overlay.resolutions.values()][0]?.typesFile.endsWith("v5/sub.d.ts")).toBe(true);
});

test("corrupt cached bytes are rejected on every offline replay", async () => {
  const root = fixture();
  const calls = registry();
  const cacheDir = join(root, "cache");
  await prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir });
  const tarball = readdirSync(cacheDir)[0];
  expect(tarball).toBeDefined();
  writeFileSync(join(cacheDir, tarball ?? "missing"), "corrupted");
  calls.mockClear();
  await expect(prepareTypeAcquisition(join(root, "main.ts"), { mode: "offline", cacheDir })).rejects.toThrow("integrity mismatch");
  expect(calls).not.toHaveBeenCalled();
});

test("local mode and frozen missing locks never access the registry", async () => {
  const root = fixture();
  const calls = registry();
  expect((await prepareTypeAcquisition(join(root, "main.ts"), { mode: "local" })).files.size).toBe(0);
  await expect(prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", frozenLock: true })).rejects.toThrow("lock miss");
  expect(calls).not.toHaveBeenCalled();
});


test("two installed runtime versions receive contextual declaration versions", async () => {
  const root = fixture({
    "main.ts": 'import { one } from "./a/value.ts"; import { two } from "./b/value.ts"; console.log(one, two);\n',
    "a/value.ts": 'import { answer } from "type-example"; export const one: number = answer();\n',
    "b/value.ts": 'import { answer } from "type-example"; export const two: string = answer();\n',
    "a/node_modules/type-example/package.json": JSON.stringify({ name: "type-example", version: "1.0.0", main: "index.js", type: "module" }),
    "a/node_modules/type-example/index.js": "export function answer() { return 1; }\n",
    "b/node_modules/type-example/package.json": JSON.stringify({ name: "type-example", version: "2.0.0", main: "index.js", type: "module" }),
    "b/node_modules/type-example/index.js": "export function answer() { return 'two'; }\n",
  });
  registryPackages([
    { name: "@types/type-example", version: "1.0.3" },
    { name: "@types/type-example", version: "2.0.7", files: { "index.d.ts": "export function answer(): string;\n" } },
  ]);
  const overlay = await prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir: join(root, "cache") });
  expect(withDeclarationOverlay(overlay, () => preflight(root))).toEqual([]);
  expect(new Set([...overlay.resolutions.values()].map(r => r.version))).toEqual(new Set(["1.0.3", "2.0.7"]));
});

test("transitive declaration dependencies are pinned, loaded and verified offline", async () => {
  const root = fixture();
  const calls = registryPackages([
    { name: "@types/type-example", version: "1.0.3", manifest: { dependencies: { "@types/answer-model": "^2.0.0" } }, files: {
      "index.d.ts": 'import type { Answer } from "answer-model"; export function answer(): Answer;\n',
    } },
    { name: "@types/answer-model", version: "2.0.5", files: { "index.d.ts": "export type Answer = number;\n" } },
  ]);
  const cacheDir = join(root, "cache");
  const overlay = await prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir });
  expect(withDeclarationOverlay(overlay, () => preflight(root))).toEqual([]);
  const lock = JSON.parse(readFileSync(join(root, "scriptc.types.lock.json"), "utf8"));
  expect(lock.packages["@types/type-example@1.0.3"].dependencies).toEqual({ "@types/answer-model": "@types/answer-model@2.0.5" });
  calls.mockClear();
  await prepareTypeAcquisition(join(root, "main.ts"), { mode: "offline", cacheDir });
  expect(calls).not.toHaveBeenCalled();
});

test("incompatible declaration major versions are not silently chosen", async () => {
  const root = fixture();
  registryPackages([{ name: "@types/type-example", version: "2.0.0" }]);
  await expect(prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir: join(root, "cache") })).rejects.toThrow("no compatible declarations");
});


test("unresolved declaration imports cannot be hidden by the consumer's skipLibCheck", async () => {
  const root = fixture();
  registry({ "index.d.ts": 'import type { Answer } from "missing-answer-model"; export function answer(): Answer;\n' });
  await expect(prepareTypeAcquisition(join(root, "main.ts"), { mode: "auto", cacheDir: join(root, "cache") }))
    .rejects.toThrow("declaration graph is incomplete: TS2307");
});
