import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { BOOL, DYN, F64, STRING, UNDEFINED_T, VOID, shapeHasAccessorSlots, typeEquals, type IrExpr, type IrStmt } from "../../ir/ir.js";
import type { ClassInfo } from "./lower-classes.js";
import { nodeThrowExpr, type Lowerer } from "./lowerer.js";
import { probeLower } from "./lower-exprs.js";

/** Find the storage declarer, not the receiver's nominal class: inherited
 * fieldSet receivers must be upcast to the class that owns the slot. */
function fieldOwner(info: ClassInfo, name: string): ClassInfo | null {
  for (let current: ClassInfo | null = info; current; current = current.base) {
    if (current.def.fields.some(field => field.name === name)) return current;
  }
  return null;
}

function publicStringField(info: ClassInfo, name: string): boolean {
  return !name.startsWith("#") && ![...(info.symbolFields?.values() ?? [])].includes(name);
}

/** Walk real own keys, not a type's optional slots: an explicitly present
 * undefined overwrites, and a missing property does not. Native layout has
 * no general expando slot; unknown keys are refused at their copy position,
 * after earlier writes, rather than silently dropped. */
function dynamicAssignHelper(lowerer: Lowerer, info: ClassInfo, call: ts.CallExpression): string {
  const key = `obj.assign.class:${info.def.name}:dyn`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = `%obj.assign.class.${lowerer.arrHofHelpers.size}`;
  const loc = locOf(call);
  const targetType = { kind: "object", className: info.def.name } as const;
  const target: IrExpr = { kind: "varRef", localId: "target.0", type: targetType, loc };
  const source: IrExpr = { kind: "varRef", localId: "source.1", type: DYN, loc };
  const keys: IrExpr = { kind: "varRef", localId: "keys.0", type: DYN, loc };
  const index: IrExpr = { kind: "varRef", localId: "index.0", type: F64, loc };
  const property: IrExpr = { kind: "varRef", localId: "key.0", type: STRING, loc };
  const writes: IrStmt[] = [];
  for (const field of info.fields.keys()) {
    const owner = fieldOwner(info, field);
    if (!owner || !publicStringField(info, field)) continue;
    const expected = owner.fields.get(field);
    if (!expected) continue;
    const raw: IrExpr = { kind: "dynKeyGet", value: source, key: property, type: DYN, loc };
    const value = lowerer.coerceToExpected(raw, expected);
    if (!typeEquals(value.type, expected)) continue;
    writes.push({ kind: "if", cond: {
      kind: "strEq", left: property, right: { kind: "strLit", value: field, type: STRING, loc }, negated: false, type: BOOL, loc,
    }, then: [
      { kind: "fieldSet", obj: lowerer.upcastTo(target, owner.def.name), className: owner.def.name, field, value, loc },
      { kind: "continue", loc },
    ], else_: null, loc });
  }
  const body: IrStmt[] = [
    { kind: "if", cond: { kind: "dynTest", test: "nullish", value: source, type: BOOL, loc }, then: [{ kind: "return", value: target, loc }], else_: null, loc },
    { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.objectAssignSourceCheck", args: [source], type: VOID, loc }, loc },
    { kind: "varDecl", localId: "keys.0", init: { kind: "libCall", fn: "dyn.objKeys", args: [source], type: DYN, loc }, loc },
    { kind: "varDecl", localId: "index.0", init: { kind: "numLit", value: 0, type: F64, loc }, loc },
    { kind: "while", cond: { kind: "bin", op: "<", left: index, right: { kind: "libCall", fn: "dyn.arrLen", args: [keys], type: F64, loc }, type: BOOL, loc }, body: [
      { kind: "varDecl", localId: "key.0", init: { kind: "dynCheck", value: { kind: "libCall", fn: "dyn.arrAt", args: [keys, index], type: DYN, loc }, type: STRING, loc }, loc },
      { kind: "assign", localId: "index.0", value: { kind: "bin", op: "+", left: index, right: { kind: "numLit", value: 1, type: F64, loc }, type: F64, loc }, loc },
      { kind: "if", cond: { kind: "libCall", fn: "dyn.hasOwn", args: [source, property], type: BOOL, loc }, then: [
        ...writes,
        { kind: "exprStmt", expr: nodeThrowExpr(0, "SC1031", "scriptc SC1031: Object.assign onto native classes requires a declared writable field", VOID, loc), loc },
      ], else_: null, loc },
    ], loc },
    { kind: "return", value: target, loc },
  ];
  lowerer.arrHofHelpers.set(key, name);
  lowerer.liftedFns.push({ name, params: [
    { localId: "target.0", name: "target", type: targetType }, { localId: "source.1", name: "source", type: DYN },
  ], returnType: targetType, locals: [
    { id: "target.0", name: "target", type: targetType, mutable: false }, { id: "source.1", name: "source", type: DYN, mutable: false },
    { id: "keys.0", name: "keys", type: DYN, mutable: false }, { id: "index.0", name: "index", type: F64, mutable: true },
    { id: "key.0", name: "key", type: STRING, mutable: false },
  ], body, loc });
  return name;
}

/** A closed data-record source mutates existing native class slots. Unknown
 * keys, accessor sources and optional-key presence retain explicit fences. */
export function lowerObjectAssignClass(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.arguments.length !== 2 || call.arguments.some(ts.isSpreadElement)) return null;
  const [targetNode, sourceNode] = call.arguments;
  if (!targetNode || !sourceNode) return null;
  const targetType = probeLower(lowerer, targetNode)?.type;
  if (targetType?.kind !== "object") return null;
  const info = lowerer.classes.get(targetType.className);
  if (!info) return null;
  const sourceType = probeLower(lowerer, sourceNode)?.type;
  if (sourceType?.kind === "dyn") {
    const target = lowerer.lowerExpr(targetNode);
    const source = lowerer.lowerExpr(sourceNode);
    const callee = dynamicAssignHelper(lowerer, info, call);
    return { kind: "call", callee, args: [target, source], type: targetType, loc: locOf(call) };
  }
  if (sourceType?.kind !== "record") return null;
  const shape = lowerer.shapes.get(sourceType.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shapeHasAccessorSlots(shape)) return null;
  if (shape.fields.some(field => field.type.kind === "union" && lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0)) return null;
  const loc = locOf(call);
  const target = lowerer.lowerExpr(targetNode);
  const source = lowerer.lowerExpr(sourceNode);
  if (!typeEquals(target.type, targetType) || !typeEquals(source.type, sourceType)) return null;
  const targetSlot = lowerer.declareHiddenLocal("%assignTarget", targetType);
  const sourceSlot = lowerer.declareHiddenLocal("%assignSource", sourceType);
  const targetRef: IrExpr = { kind: "varRef", localId: targetSlot.id, type: targetType, loc };
  const sourceRef: IrExpr = { kind: "varRef", localId: sourceSlot.id, type: sourceType, loc };
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: targetSlot.id, init: target, loc },
    { kind: "varDecl", localId: sourceSlot.id, init: source, loc },
  ];
  const names = shape.declaredOrder ?? shape.fields.map(field => field.name);
  for (const name of names) {
    const field = shape.fields.find(candidate => candidate.name === name);
    if (!field) continue;
    const owner = fieldOwner(info, name);
    if (!owner || !publicStringField(info, name)) lowerer.unsupported("SC1090", call, `Object.assign onto a class with undeclared public string property '${name}'`);
    const expected = owner.fields.get(name);
    if (!expected) lowerer.unsupported("SC1090", call, `Object.assign onto class field '${name}' without a native storage type`);
    const raw: IrExpr = { kind: "recordGet", obj: sourceRef, shapeId: sourceType.shapeId, field: name, type: field.type, loc };
    const value = lowerer.coerceToExpected(raw, expected);
    if (!typeEquals(value.type, expected)) lowerer.unsupported("SC1090", call, `Object.assign onto class field '${name}' with an incompatible value type`);
    stmts.push({ kind: "fieldSet", obj: lowerer.upcastTo(targetRef, owner.def.name), className: owner.def.name, field: name, value, loc });
  }
  return { kind: "seqExpr", stmts, result: targetRef, type: targetType, loc };
}
