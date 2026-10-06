import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program.js";

test("exporting a hoisted CommonJS function does not invoke it before require bindings initialize", () => {
  const load = loadProgram(resolve("tests/corpus/3415-cjs-function-export-prefix/main.cjs"));
  try { expect(checkPreflight(load)).toEqual([]); }
  finally { load.dispose(); }
});

test.each([
  ["an exports member", "exports.answer = serialize;"],
  ["a module.exports member", "module.exports.answer = serialize;"],
  ["a literal element member", "exports['answer'] = serialize;"],
  ["a whole export after a side effect", "console.log('init'); module.exports = serialize;"],
  ["a member after a data descriptor", "Object.defineProperty(exports, '__esModule', { value: true }); exports.answer = serialize;"],
  ["a member after chained data exports", "exports.first = exports.second = void 0; exports.answer = serialize;"],
  ["a member after a builtin fallback read", "const ownKeys = Object.getOwnPropertyNames || (() => []); exports.answer = serialize;"],
])("storing a hoisted function in %s defers its require reads", (_name, prefix) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-require-tdz-store-"));
  try {
    writeFileSync(join(directory, "helper.cjs"), "exports.format = value => String(value);\n");
    const entry = join(directory, "main.cjs");
    writeFileSync(entry, `${prefix}\nconst { format } = require('./helper.cjs');\nfunction serialize(value) { return format(value); }\n`);
    const load = loadProgram(entry);
    try { expect(checkPreflight(load)).toEqual([]); }
    finally { load.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([
  ["a member call", "exports.answer = serialize; exports.answer('early');"],
  ["a member setter", "Object.defineProperty(exports, 'answer', { set: fn => fn('early') }); exports.answer = serialize;"],
  ["an escaped receiver", "const alias = exports; Object.defineProperty(alias, 'answer', { set: fn => fn('early') }); exports.answer = serialize;"],
  ["a captured receiver", "install(); exports.answer = serialize; function install() { Object.defineProperty(exports, 'answer', { set: fn => fn('early') }); }"],
  ["a replaced receiver", "module.exports = { set answer(fn) { fn('early'); } }; module.exports.answer = serialize;"],
  ["a prototype setter", "exports.__proto__ = { set answer(fn) { fn('early'); } }; exports.answer = serialize;"],
  ["an inherited setter", "Object.defineProperty(Object.prototype, 'answer', { set: fn => fn('early') }); exports.answer = serialize;"],
  ["a mutated descriptor builtin", "Object.defineProperty = () => { exports.__proto__ = { set answer(fn) { fn('early'); } }; }; Object.defineProperty(exports, '__esModule', { value: true }); exports.answer = serialize;"],
])("a hoisted member export retains TDZ refusal with %s", (_name, prefix) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-require-tdz-store-risk-"));
  try {
    writeFileSync(join(directory, "helper.cjs"), "exports.format = value => String(value);\n");
    const entry = join(directory, "main.cjs");
    writeFileSync(entry, `${prefix}\nconst { format } = require('./helper.cjs');\nfunction serialize(value) { return format(value); }\n`);
    const load = loadProgram(entry);
    try {
      const oracle = execFileSync(process.execPath, ["-e", "try { require(process.argv[1]); } catch (error) { console.log(error.name); }", entry], { encoding: "utf8" });
      expect(oracle).toBe("ReferenceError\n");
      expect(checkPreflight(load)).toContainEqual(expect.objectContaining({ code: "SC1013", message: expect.stringContaining("binding 'format'") }));
    }
    finally { load.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([
  ["a direct call", "serialize('early');"],
  ["an invoked export RHS", "module.exports = serialize('early');"],
  ["a call through the exported value", "module.exports('early');"],
  ["a synchronous callback", "invoke(serialize); function invoke(fn) { return fn('early'); }"],
  ["a local alias", "const alias = serialize; alias('early');"],
  ["a self-require call", "const self = require('./main.cjs'); self('early');"],
  ["a getter evaluated by assignment", "Object.defineProperty(module, 'exports', { set: serialize });"],
])("CommonJS prefix admission retains TDZ refusal for %s", (_name, beforeRequire) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-require-tdz-"));
  try {
    writeFileSync(join(directory, "helper.cjs"), "exports.format = value => String(value);\n");
    const entry = join(directory, "main.cjs");
    writeFileSync(entry, `module.exports = serialize;\n${beforeRequire}\nconst { format } = require('./helper.cjs');\nfunction serialize(value) { return format(value); }\n`);
    const load = loadProgram(entry);
    try {
      expect(checkPreflight(load)).toContainEqual(expect.objectContaining({
        code: "SC1013", message: expect.stringContaining("binding 'format'"),
      }));
    } finally { load.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an arrow export does not broaden the hoisted-function prefix exception", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-require-tdz-arrow-"));
  try {
    writeFileSync(join(directory, "helper.cjs"), "exports.format = value => String(value);\n");
    const entry = join(directory, "main.cjs");
    writeFileSync(entry, "module.exports = value => format(value);\nconst { format } = require('./helper.cjs');\n");
    const load = loadProgram(entry);
    try { expect(checkPreflight(load)).toContainEqual(expect.objectContaining({ code: "SC1013" })); }
    finally { load.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("CommonJS cycles cannot expose a hoisted export before its require completes", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-require-tdz-cycle-"));
  try {
    const pkg = join(directory, "node_modules", "early-export");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"early-export","main":"index.cjs","types":"index.d.ts"}\n');
    writeFileSync(join(pkg, "index.d.ts"), "declare function serialize(value: string): string; export = serialize;\n");
    writeFileSync(join(pkg, "index.cjs"), "module.exports = serialize;\nconst { format } = require('./helper.cjs');\nfunction serialize(value) { return format(value); }\n");
    writeFileSync(join(pkg, "helper.cjs"), "const serialize = require('./index.cjs');\nserialize('early');\nexports.format = value => value;\n");
    const entry = join(directory, "main.cjs");
    writeFileSync(entry, "const serialize = require('early-export');\nconsole.log(serialize('later'));\n");
    const load = loadProgram(entry, { npmStatic: ["early-export"] });
    try {
      expect(checkPreflight(load)).toContainEqual(expect.objectContaining({ code: "SC1016" }));
    } finally { load.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
