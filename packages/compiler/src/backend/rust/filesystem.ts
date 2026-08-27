import { mangleField, mangleRecordStruct } from "../mangle.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

/** Emit filesystem calls whose result needs compiler-owned record assembly. */
export function emitRustFilesystemCall(
  expr: RustLibCallExpr,
  context: RustLibCallContext,
): string | null {
  if (expr.fn !== "fs.readdirTypesSync") return null;
  const [pathExpr] = expr.args;
  if (pathExpr?.type.kind !== "string" || expr.args.length !== 1 ||
      expr.type.kind !== "array" || expr.type.elem.kind !== "record") {
    context.unsupported("fs.readdirTypesSync shape", expr.loc);
  }
  const rowType = expr.type.elem;
  const shape = context.record(rowType.shapeId, expr.loc);
  const expected = [
    ["%dtype", "f64"],
    ["name", "string"],
    ["parentPath", "string"],
  ] as const;
  if (shape.tuple || shape.indexValue !== undefined || shape.fields.length !== expected.length ||
      shape.fields.some((field, index) =>
        field.name !== expected[index]?.[0] || field.type.kind !== expected[index]?.[1]
      )) {
    context.unsupported("fs.readdirTypesSync record", expr.loc);
  }

  const path = context.nextTemporary();
  const output = context.nextTemporary();
  const entry = context.nextTemporary();
  const fields = [
    `${mangleField("%dtype")}: ${entry}.kind`,
    `${mangleField("name")}: ${entry}.name`,
    `${mangleField("parentPath")}: ${path}.clone()`,
  ].join(", ");
  return `{ let ${path} = ${context.emitExpr(pathExpr)}; let ${output}: ${context.rustType(expr.type, expr.loc)} = runtime::array_new(Vec::new()); for ${entry} in runtime::fs_readdir_types(&${path}) { let sc_row = runtime::Gc::new(${mangleRecordStruct(rowType.shapeId)} { ${fields} }); runtime::array_push(&${output}, sc_row); } ${output} }`;
}
