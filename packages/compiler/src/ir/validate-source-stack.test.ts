import { expect, test } from "vitest";
import { STRING, UNDEFINED_T, VOID, type IrModule } from "./ir.js";
import { serializeModule, deserializeModule } from "./serialize.js";
import { validateModule } from "./validate.js";

function moduleWithCoordinates(): IrModule {
  const loc = { file: "source.cjs", start: 0, end: 1 };
  return { irVersion: 12, sourceFile: loc.file, entry: "main", functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }],
    sourceStackFiles: [{ file: loc.file, displayFile: "/original/source.cjs", length: 30, lineStarts: [0, 12], callOffsets: [{ start: 2, end: 10, position: 6 }] }] };
}

test("source stack coordinates survive the public IR round-trip", () => {
  const module = moduleWithCoordinates();
  const restored = deserializeModule(serializeModule(module));
  expect(restored.sourceStackFiles).toEqual(module.sourceStackFiles);
  expect(validateModule(restored)).toEqual([]);
});

function moduleWithCapture(): IrModule {
  const module = moduleWithCoordinates();
  const fn = module.functions[0];
  if (!fn) throw new Error("missing function");
  const loc = fn.loc;
  fn.body.push({ kind: "exprStmt", loc, expr: { kind: "libCall", fn: "error.captureStackTrace", type: UNDEFINED_T, loc, args: [
    { kind: "libCall", fn: "error.new", args: [{ kind: "strLit", value: "message", type: STRING, loc }], type: { kind: "object", className: "%Error" }, loc },
  ] } });
  return module;
}

test("native source capture requires coordinates rather than inventing frames", () => {
  const module = moduleWithCapture();
  delete module.sourceStackFiles;
  expect(validateModule(module)).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("source stack requires original-source coordinates") })]));
});

test("native source capture cannot use another file's coordinates", () => {
  const module = moduleWithCapture();
  const file = module.sourceStackFiles?.[0];
  if (!file) throw new Error("missing metadata");
  file.file = "other.cjs";
  expect(validateModule(module)).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("source stack operation requires matching source coordinates") })]));
});

test.each([
  ["missing zero", [1, 12]],
  ["out of order", [0, 12, 8]],
  ["duplicate line", [0, 12, 12]],
  ["negative offset", [0, -1]],
  ["fractional offset", [0, 1.5]],
  ["non-finite offset", [0, Infinity]],
] as const)("source stack rejects %s", (_name, starts) => {
  const module = moduleWithCoordinates();
  const file = module.sourceStackFiles?.[0];
  if (!file) throw new Error("missing test metadata");
  file.lineStarts = [...starts];
  expect(validateModule(module)).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("source stack") })]));
});
