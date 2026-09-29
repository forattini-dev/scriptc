import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { InternalCompilerError } from "../../errors.js";
import { locOf } from "../program.js";
import { BOOL, DYN, F64, STRING, VOID, typeEquals, typeKey, type IrExpr, type IrFunction, type IrLocal, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
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
    if (receiverType?.kind !== "map" && receiverType?.kind !== "set" && receiverType?.kind !== "searchParams") return null;
    mode = node.expression.name.text as Mode;
    node = receiver;
  }
  // `String.prototype.matchAll` is eagerly lowered to a native array of
  // match rows. The checker intentionally retains its iterator type, so
  // recognize the direct builtin call before consulting that static shape.
  if (
    mode === undefined &&
    ts.isCallExpression(node) &&
    !node.questionDotToken &&
    node.arguments.length === 1 &&
    ts.isPropertyAccessExpression(node.expression) &&
    !node.expression.questionDotToken &&
    node.expression.name.text === "matchAll" &&
    L.isStdlibMember(node.expression) &&
    L.mapTypeOf(L.typeOf(node.expression.expression))?.kind === "string"
  ) {
    const value = L.lowerExpr(node);
    if (value.type.kind === "array") return { value, element: value.type.elem, mode: "values" };
  }
  const mapped = L.mapTypeOf(L.typeOf(node));
  if (!mapped || !["array", "set", "map", "record", "string", "searchParams"].includes(mapped.kind)) return null;
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
  else if (type.kind === "searchParams") element = STRING;
  else if (type.kind === "record" && shape?.tuple) element = shape.fields[0]!.type;
  else return null;
  mode ??= type.kind === "map" || type.kind === "searchParams" ? "entries" : "values";
  if (mode === "entries") {
    const key = type.kind === "map" ? type.key : element;
    element = { kind: "record", shapeId: L.shapes.intern([{ name: "0", type: key }, { name: "1", type: element }], true) };
  }
  return { value, element, mode };
}

/** `[...map]`: the Map's live entries snapshot into a fresh `[K, V][]` (insertion order, JS-exact), the same
 * materialization Array.from(map) uses. Null when the value is not a native Map. */
export function lowerMapEntriesSpread(L: Lowerer, value: IrExpr, loc: SrcLoc): IrExpr | null {
  if (value.type.kind !== "map") return null;
  const element: IrType = { kind: "record", shapeId: L.shapes.intern([{ name: "0", type: value.type.key }, { name: "1", type: value.type.value }], true) };
  return materialize(L, { value, element, mode: "entries" }, undefined, loc);
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
  // A capture row has the runtime-honest `(string | undefined)[]` element
  // type, while TypeScript's RegExpMatchArray index signature still says
  // `string`. The pure identity mapper cannot observe that declaration lie;
  // Array.from(source, value => value) is exactly a fresh shallow copy.
  if (mapperNode && identityMapper(L, mapperNode)) return materialize(L, source, undefined, locOf(call));
  const mapper = mapperNode ? L.lowerExpr(mapperNode) : undefined;
  if (mapper && (mapper.type.kind !== "func" || mapper.type.params.length > 2 ||
      (mapper.type.params.length > 0 && !typeEquals(mapper.type.params[0]!, source.element)) ||
      (mapper.type.params.length > 1 && mapper.type.params[1]!.kind !== "f64"))) {
    L.noLowering("Array.from with this mapper signature", mapperNode!, "the native mapper accepts the element and optional numeric index");
  }
  const output = mapper?.type.kind === "func" ? mapper.type.ret : source.element;
  if (mapper && output.kind === "dyn" && source.value.type.kind === "array" && L.nativeCollectionArrays) {
    return materializeDynamicArray(L, source.value, mapper, locOf(call));
  }
  if (mapper && output.kind === "dyn" && source.value.type.kind === "map" && L.nativeDynamicMaps) {
    return materializeDynamicMap(L, source, mapper, locOf(call));
  }
  if (!mapper && output.kind === "dyn" && source.value.type.kind === "set" && L.nativeDynamicSets) {
    return materializeDynamicSet(L, source.value, locOf(call));
  }
  fenceProducedArrayElem(L, call, "'Array.from(collection, mapper)'", output);
  return materialize(L, source, mapper, locOf(call));
}

function identityMapper(L: Lowerer, node: ts.Expression): boolean {
  let value = node;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (!ts.isArrowFunction(value) || value.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (value.parameters.length !== 1 || !ts.isIdentifier(value.parameters[0]!.name) || value.parameters[0]!.initializer || value.parameters[0]!.dotDotDotToken) return false;
  let body: ts.Expression | ts.ConciseBody = value.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isIdentifier(body)) return false;
  return L.resolveValueSymbol(value.parameters[0]!.name) === L.resolveValueSymbol(body);
}

/** Rust-only Array<T> mapping whose callback result is checked-dynamic.
 * The source length is re-read every iteration, matching ArrayIterator's
 * live append behavior, while dyn.packPush retains each mapped result. */
function materializeDynamicArray(L: Lowerer, source: IrExpr, mapper: IrExpr, loc: SrcLoc): IrExpr {
  if (source.type.kind !== "array" || mapper.type.kind !== "func" || mapper.type.ret.kind !== "dyn") {
    throw new InternalCompilerError("dynamic Array materialization requires an array and a dyn-returning mapper");
  }
  const sourceType = source.type;
  const mapperType = mapper.type;
  const key = `materializeDynArray:${typeKey(sourceType)}:${typeKey(mapperType)}`;
  let helper = L.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%collection.fromDynArray.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const receiver = varRef("source.0", sourceType, loc);
    const mapperRef = varRef("mapper.0", mapperType, loc);
    const cursor = varRef("i.0", F64, loc);
    const out = varRef("out.0", DYN, loc);
    const element: IrExpr = { kind: "arrayGet", arr: receiver, index: cursor, type: sourceType.elem, loc };
    const mapped: IrExpr = {
      kind: "callValue",
      callee: mapperRef,
      args: [element, cursor].slice(0, mapperType.params.length),
      type: DYN,
      loc,
    };
    const length: IrExpr = { kind: "arrIntrinsic", method: "length", receiver, args: [], type: F64, loc };
    const loop = countedFor(loc, length, () => [
      { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.packPush", args: [out, mapped], type: VOID, loc }, loc },
    ]);
    L.liftedFns.push({
      name: helper,
      params: [
        { localId: "source.0", name: "source", type: sourceType },
        { localId: "mapper.0", name: "mapper", type: mapperType },
      ],
      returnType: DYN,
      locals: [
        { id: "source.0", name: "source", type: sourceType, mutable: false },
        { id: "mapper.0", name: "mapper", type: mapperType, mutable: false },
        { id: "out.0", name: "out", type: DYN, mutable: false },
        { id: "i.0", name: "cursor", type: F64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: { kind: "dynArrLit", elems: [], type: DYN, loc }, loc },
        loop,
        { kind: "return", value: out, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [source, mapper], type: DYN, loc };
}

/** Rust-only Map<dyn, dyn> materialization keeps the outer unknown[] in the
 * checked-dynamic representation. Mapper calls remain interleaved with live
 * iterator reads, including insertion/deletion behavior and callback index. */
function materializeDynamicMap(L: Lowerer, source: Source, mapper: IrExpr, loc: SrcLoc): IrExpr {
  const mapType = source.value.type;
  if (mapType.kind !== "map" || mapType.key.kind !== "dyn" || mapType.value.kind !== "dyn" || mapper.type.kind !== "func" || mapper.type.ret.kind !== "dyn") {
    throw new InternalCompilerError("dynamic Map materialization requires Map<dyn, dyn> and a dyn-returning mapper");
  }
  const key = `materializeDynMap:${typeKey(mapType)}:${source.mode}:${typeKey(source.element)}:${typeKey(mapper.type)}`;
  let helper = L.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%collection.fromDynMap.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const mapperType = mapper.type;
    const receiver = varRef("source.0", mapType, loc);
    const mapperRef = varRef("mapper.0", mapperType, loc);
    const cursor = varRef("i.0", F64, loc);
    const index = varRef("index.0", F64, loc);
    const out = varRef("out.0", DYN, loc);
    const iter = (method: "iterCount" | "iterLive" | "iterKey" | "iterValue" | "iterEnter" | "iterExit", args: IrExpr[], output: IrType): IrExpr => ({
      kind: "mapIntrinsic", method, receiver, args, type: output, loc,
    });
    const mapKey = iter("iterKey", [cursor], DYN);
    const mapValue = iter("iterValue", [cursor], DYN);
    const element: IrExpr = source.mode === "entries"
      ? { kind: "recordLit", fields: [{ name: "0", value: mapKey }, { name: "1", value: mapValue }], type: source.element, loc }
      : source.mode === "keys" ? mapKey : mapValue;
    const mapped: IrExpr = {
      kind: "callValue",
      callee: mapperRef,
      args: [element, index].slice(0, mapperType.params.length),
      type: DYN,
      loc,
    };
    const loop = countedFor(loc, iter("iterCount", [], F64), () => [{
      kind: "if",
      cond: iter("iterLive", [cursor], BOOL),
      then: [
        { kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.packPush", args: [out, mapped], type: VOID, loc }, loc },
        { kind: "assign", localId: "index.0", value: { kind: "bin", op: "+", left: index, right: numLit(1, loc), type: F64, loc }, loc },
      ],
      else_: null,
      loc,
    }]);
    L.liftedFns.push({
      name: helper,
      params: [
        { localId: "source.0", name: "source", type: mapType },
        { localId: "mapper.0", name: "mapper", type: mapperType },
      ],
      returnType: DYN,
      locals: [
        { id: "source.0", name: "source", type: mapType, mutable: false },
        { id: "mapper.0", name: "mapper", type: mapperType, mutable: false },
        { id: "out.0", name: "out", type: DYN, mutable: false },
        { id: "i.0", name: "cursor", type: F64, mutable: true },
        { id: "index.0", name: "index", type: F64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: { kind: "dynArrLit", elems: [], type: DYN, loc }, loc },
        { kind: "varDecl", localId: "index.0", init: numLit(0, loc), loc },
        { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
        {
          kind: "tryCatch", tryBody: [loop], catchBody: null, catchLocalId: null,
          finallyBody: [{ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc }], loc,
        },
        { kind: "return", value: out, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [source.value, mapper], type: DYN, loc };
}

/** Rust-only Set<dyn> snapshot into the existing checked-dynamic array
 * representation. Keeping unknown[] as one dyn value avoids perturbing the
 * established dynamic-array boundary while still materializing the native
 * Set iterator in insertion order. */
function materializeDynamicSet(L: Lowerer, source: IrExpr, loc: SrcLoc): IrExpr {
  const setType = source.type;
  if (setType.kind !== "set" || setType.elem.kind !== "dyn") throw new InternalCompilerError("dynamic Set materialization requires Set<dyn>");
  const key = `materializeDynSet:${typeKey(setType)}`;
  let helper = L.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%collection.fromDynSet.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const receiver = varRef("source.0", setType, loc);
    const cursor = varRef("i.0", F64, loc);
    const out = varRef("out.0", DYN, loc);
    const iter = (method: "iterCount" | "iterLive" | "iterKey" | "iterEnter" | "iterExit", args: IrExpr[], output: IrType): IrExpr => ({
      kind: "setIntrinsic", method, receiver, args, type: output, loc,
    });
    const loop = countedFor(loc, iter("iterCount", [], F64), () => [{
      kind: "if",
      cond: iter("iterLive", [cursor], BOOL),
      then: [{ kind: "exprStmt", expr: { kind: "libCall", fn: "dyn.packPush", args: [out, iter("iterKey", [cursor], DYN)], type: VOID, loc }, loc }],
      else_: null,
      loc,
    }]);
    L.liftedFns.push({
      name: helper,
      params: [{ localId: "source.0", name: "source", type: setType }],
      returnType: DYN,
      locals: [
        { id: "source.0", name: "source", type: setType, mutable: false },
        { id: "out.0", name: "out", type: DYN, mutable: false },
        { id: "i.0", name: "cursor", type: F64, mutable: true },
      ],
      body: [
        { kind: "varDecl", localId: "out.0", init: { kind: "dynArrLit", elems: [], type: DYN, loc }, loc },
        { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
        {
          kind: "tryCatch", tryBody: [loop], catchBody: null, catchLocalId: null,
          finallyBody: [{ kind: "exprStmt", expr: iter("iterExit", [], VOID), loc }], loc,
        },
        { kind: "return", value: out, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [source], type: DYN, loc };
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
  } else if (type.kind === "searchParams") {
    length = { kind: "libCall", fn: "sp.size", args: [receiver], type: F64, loc };
    const key: IrExpr = { kind: "libCall", fn: "sp.keyAt", args: [receiver, cursor], type: STRING, loc };
    const payload: IrExpr = { kind: "libCall", fn: "sp.valAt", args: [receiver, cursor], type: STRING, loc };
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
