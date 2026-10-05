import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
