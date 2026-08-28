import type { IrExpr, IrRecordShape, IrType, SrcLoc } from "../../ir/nodes.js";
import { mangleField, mangleRecordStruct } from "../mangle.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";

interface RustArrayNewLenContext {
  readonly records: ReadonlyMap<string, IrRecordShape>;
  defaultValue(type: IrType, loc: SrcLoc): string;
  isEdgeValue(type: IrType): boolean;
  nextName(prefix: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export function emitRustArrayNewLen(
  expr: Extract<IrExpr, { kind: "arrayNewLen" }>,
  context: RustArrayNewLenContext,
  emitExpr: (expr: IrExpr) => string,
): string {
  if (expr.type.kind !== "array") context.unsupported("arrayNewLen with a non-array type", expr.loc);
  const elem = expr.type.elem;
  let absent: string;
  if (elem.kind === "record") {
    const shape = context.records.get(elem.shapeId);
    if (shape === undefined) context.unsupported(`unknown record shape '${elem.shapeId}'`, expr.loc);
    if (shape.indexValue !== undefined && shape.fields.length === 0) {
      absent = "runtime::map_new()";
    } else {
      const fields = shape.fields.map((field) => `${mangleField(field.name)}: ${
        context.isEdgeValue(field.type) ? "None" : context.defaultValue(field.type, expr.loc)
      }`).join(", ");
      const overflow = shape.indexValue === undefined ? "" : `, ${RUST_RECORD_OVERFLOW}: None`;
      absent = `runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields}${overflow} })`;
    }
  } else if (elem.kind === "union") {
    absent = context.defaultValue(elem, expr.loc);
  } else {
    context.unsupported(`arrayNewLen with '${elem.kind}' elements`, expr.loc);
  }
  const length = context.nextName("sc_rt");
  const array = context.nextName("sc_rt");
  const fill = context.nextName("sc_rt");
  const index = context.nextName("sc_rt");
  return `{ let ${length} = ${emitExpr(expr.length)}; let ${array}: ${context.rustType(expr.type, expr.loc)} = runtime::array_new(Vec::new()); let ${fill} = ${absent}; let mut ${index} = 0.0; while ${index} <= ${length} - 1.0 { runtime::array_push(&${array}, ${fill}.clone()); ${index} += 1.0; } ${array} }`;
}
