import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { InternalCompilerError } from "../../errors.js";
import { locOf } from "../program.js";
import { BOOL, F64, VOID, typeEquals, typeKey, type IrExpr, type IrFunction, type IrLocal, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { boolLit, countedFor, numLit, varRef } from "../../ir/build.js";
import { fenceProducedArrayElem, strCharsCall } from "./lower-containers.js";
import { tupleSpreadArray } from "./lower-native-containers.js";

type Mode = "values" | "keys" | "entries";
interface Source {
  value: IrExpr;
  element: IrType;
  mode: Mode;
}

/** Only built-in collection calls may bypass materializing an iterator object.
 * A stored iterator, overridden method, or user iterable retains its own path. */
function collectionSource(L: Lowerer, input: ts.Expression): Source | null {
  let node = input;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  let mode: Mode | undefined;
  if (ts.isCallExpression(node) && !node.questionDotToken && node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) && !node.expression.questionDotToken &&
      ["keys", "values", "entries"].includes(node.expression.name.text) && L.isStdlibMember(node.expression)) {
    const receiver = node.expression.expression;
    const receiverType = L.mapTypeOf(L.typeOf(receiver));
    if (receiverType?.kind !== "map" && receiverType?.kind !== "set") return null;
    mode = node.expression.name.text as Mode;
    node = receiver;
  }
  const mapped = L.mapTypeOf(L.typeOf(node));
  if (!mapped || !["array", "set", "map", "record", "string"].includes(mapped.kind)) return null;
  const shape = mapped.kind === "record" ? L.shapes.get(mapped.shapeId) : undefined;
  if (mapped.kind === "record" && (!shape?.tuple || shape.fields.length === 0 ||
      !shape.fields.every((f) => typeEquals(f.type, shape.fields[0]!.type)))) return null;
  let value = L.lowerExpr(node);
  if (!typeEquals(value.type, mapped)) return null;
  if (value.type.kind === "string") value = strCharsCall(L, value, locOf(node));
  const type = value.type;
  let element: IrType;
  if (type.kind === "array" || type.kind === "set") element = type.elem;
  else if (type.kind === "map") element = mode === "keys" ? type.key : type.value;
  else if (type.kind === "record" && shape?.tuple) element = shape.fields[0]!.type;
  else return null;
  mode ??= type.kind === "map" ? "entries" : "values";
  if (mode === "entries") {
    const key = type.kind === "map" ? type.key : element;
    element = { kind: "record", shapeId: L.shapes.intern([{ name: "0", type: key }, { name: "1", type: element }], true) };
  }
  return { value, element, mode };
}

/** Seed construction runs no callback, so a Set or tuple can be snapshotted
 * using existing primitives. Set storage is fresh; element identities survive. */
export function lowerCollectionSetSeed(L: Lowerer, node: ts.Expression, element: IrType): IrExpr | null {
  // Literal arrays require the constructor's expected element type, handled by
  // lowerSetNew; avoid lowering their Iterable<T> contextual union here.
  if (ts.isArrayLiteralExpression(node) || ts.isSpreadElement(node)) return null;
  const source = collectionSource(L, node);
  if (!source || !typeEquals(source.element, element)) return null;
  const type: IrType & { kind: "array" } = { kind: "array", elem: element };
  if (source.value.type.kind === "set" && source.mode !== "entries") {
    return { kind: "setIntrinsic", method: "toArray", receiver: source.value, args: [], type, loc: locOf(node) };
  }
  if (source.value.type.kind === "record") return tupleSpreadArray(L, source.value, type);
  if (source.value.type.kind === "array") return source.value;
  return materialize(L, source, undefined, locOf(node));
}

/** Array.from must interleave reads and mapper calls. Snapshotting before
 * mapping would lose appended values, visit deleted ones and read stale data. */
export function lowerCollectionFromCall(L: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.arguments.length < 1 || call.arguments.length > 2) return null;
  const source = collectionSource(L, call.arguments[0]!);
  if (!source) return null;
  const mapperNode = call.arguments[1];
  // String splitting already yields a fresh code-point array; do not copy it
  // a second time when the caller has no mapper.
  if (!mapperNode && L.mapTypeOf(L.typeOf(call.arguments[0]!))?.kind === "string") return source.value;
  const mapper = mapperNode ? L.lowerExpr(mapperNode) : undefined;
  if (mapper && (mapper.type.kind !== "func" || mapper.type.params.length > 2 ||
      (mapper.type.params.length > 0 && !typeEquals(mapper.type.params[0]!, source.element)) ||
      (mapper.type.params.length > 1 && mapper.type.params[1]!.kind !== "f64"))) {
    L.noLowering("Array.from with this mapper signature", mapperNode!, "the native mapper accepts the element and optional numeric index");
  }
  const output = mapper?.type.kind === "func" ? mapper.type.ret : source.element;
  fenceProducedArrayElem(L, call, "'Array.from(collection, mapper)'", output);
  return materialize(L, source, mapper, locOf(call));
}

function materialize(L: Lowerer, source: Source, mapper: IrExpr | undefined, loc: SrcLoc): IrExpr {
  const result: IrType & { kind: "array" } = { kind: "array", elem: mapper?.type.kind === "func" ? mapper.type.ret : source.element };
  if (!mapper && source.value.type.kind === "set" && source.mode !== "entries") {
    return { kind: "setIntrinsic", method: "toArray", receiver: source.value, args: [], type: result, loc };
  }
  const key = `materialize:${typeKey(source.value.type)}:${source.mode}:${typeKey(source.element)}:${mapper ? typeKey(mapper.type) : "copy"}`;
  let helper = L.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%collection.from.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    L.liftedFns.push(materializeFn(L, helper, source, mapper?.type, result, loc));
  }
  return { kind: "call", callee: helper, args: mapper ? [source.value, mapper] : [source.value], type: result, loc };
}

function materializeFn(L: Lowerer, name: string, source: Source, mapperType: IrType | undefined,
  result: IrType & { kind: "array" }, loc: SrcLoc): IrFunction {
  const type = source.value.type;
  const receiver = varRef("source.0", type, loc);
  const cursor = varRef("i.0", F64, loc);
  const index = varRef("index.0", F64, loc);
  const out = varRef("out.0", result, loc);
  const params = [{ localId: "source.0", name: "source", type }];
  if (mapperType) params.push({ localId: "mapper.0", name: "mapper", type: mapperType });
  const locals: IrLocal[] = [
    ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    { id: "i.0", name: "cursor", type: F64, mutable: true },
    { id: "index.0", name: "index", type: F64, mutable: true },
    { id: "out.0", name: "out", type: result, mutable: false },
  ];
  const iter = (method: "iterCount" | "iterLive" | "iterKey" | "iterEnter" | "iterExit", args: IrExpr[], output: IrType): IrExpr => {
    if (type.kind === "map") return { kind: "mapIntrinsic", method, receiver, args, type: output, loc };
    return { kind: "setIntrinsic", method, receiver, args, type: output, loc };
  };
  let length: IrExpr;
  let live = boolLit(true, loc);
  let value: IrExpr;
  const collection = type.kind === "map" || type.kind === "set";
  if (collection) {
    length = iter("iterCount", [], F64);
    live = iter("iterLive", [cursor], BOOL);
    const key = iter("iterKey", [cursor], type.kind === "map" ? type.key : type.elem);
    const payload: IrExpr = type.kind === "map"
      ? { kind: "mapIntrinsic", method: "iterValue", receiver, args: [cursor], type: type.value, loc }
      : key;
    value = source.mode === "entries"
      ? { kind: "recordLit", fields: [{ name: "0", value: key }, { name: "1", value: payload }], type: source.element, loc }
      : source.mode === "keys" ? key : payload;
  } else if (type.kind === "array") {
    length = { kind: "arrIntrinsic", method: "length", receiver, args: [], type: F64, loc };
    value = { kind: "arrayGet", arr: receiver, index: cursor, type: source.element, loc };
  } else {
    const shape = type.kind === "record" ? L.shapes.get(type.shapeId) : undefined;
    if (type.kind !== "record" || !shape?.tuple || shape.fields.length === 0) throw new InternalCompilerError("materialization requires a native collection");
    const fields = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
    length = numLit(fields.length, loc);
    const read = (field: typeof fields[number]): IrExpr => ({ kind: "recordGet", obj: receiver, shapeId: shape.id, field: field.name, type: field.type, loc });
    // Read the tuple slot inside the loop, after the preceding callback.
    // Building one array snapshot here would hide callback writes to the tuple.
    value = read(fields[fields.length - 1]!);
    for (let n = fields.length - 2; n >= 0; n--) {
      value = { kind: "ternary", cond: { kind: "bin", op: "===", left: cursor, right: numLit(n, loc), type: BOOL, loc }, then: read(fields[n]!), else_: value, type: source.element, loc };
    }
  }
  const mapped: IrExpr = mapperType?.kind === "func"
    ? { kind: "callValue", callee: varRef("mapper.0", mapperType, loc), args: [value, index].slice(0, mapperType.params.length), type: mapperType.ret, loc }
    : value;
  const visit: IrStmt[] = [
    { kind: "exprStmt", expr: { kind: "arrIntrinsic", method: "push", receiver: out, args: [mapped], type: F64, loc }, loc },
    { kind: "assign", localId: "index.0", value: { kind: "bin", op: "+", left: index, right: numLit(1, loc), type: F64, loc }, loc },
  ];
  const loop = countedFor(loc, length, () => [{ kind: "if", cond: live, then: visit, else_: null, loc }]);
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: result, loc }, loc },
    { kind: "varDecl", localId: "index.0", init: numLit(0, loc), loc },
  ];
  if (collection) {
    body.push({ kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc }, {
      kind: "tryCatch", tryBody: [loop], catchBody: null, catchLocalId: null,
      finallyBody: [{ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc }], loc,
    });
  } else body.push(loop);
  body.push({ kind: "return", value: out, loc });
  return { name, params, returnType: result, locals, body, loc };
}
