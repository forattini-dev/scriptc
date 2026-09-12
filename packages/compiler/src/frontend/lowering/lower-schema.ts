/* Kernel SCHEMA CLASSES (Schema.Class / ErrorClass / TaggedClass / TaggedErrorClass) as native classes: the props are
 * synthesized fields, the constructor takes the props record, error forms root at the runtime Error, and instances
 * print like Effect's. lower-classes.ts collects, lower-inspect.ts renders, lowerer.ts's return handles a failing yield. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import type { KernelSchemaClass } from "../kernel.js";
import { BOOL, DYN, EFFECT_T, IrExpr, IrLibFn, IrLocal, IrParam, IrStmt, IrType, STRING, SrcLoc, UNDEFINED_T, arrayOf, isSupportedArrayElem } from "../../ir/ir.js";
import { boolLit, numLit, strLit } from "../../ir/build.js";
import { effectNamespaceOf } from "./lower-effect.js";
import { SCHEMA_SLOT, isDecoratedSchema } from "../kernel-types.js";
import { declSymbolOf } from "./lower-modules.js";
import { locOf } from "../program.js";

export interface SchemaClassInfo {
  form: KernelSchemaClass["form"];
  tag: string | null;
  identifier: string;
  props: { name: string; type: IrType }[];
  /** `message` is among the props: an Error-base slot, no own field. */
  messageProp: boolean;
  /** The constructor's props record (null for a propless class: `new X()` / `new X({})`). */
  propsType: IrType | null;
}

/** The kernel schema class's synthesized shape: one field per prop of the fields literal (typed by the checker's
 * instance type, AHEAD of the body's own fields — the constructor assigns them before field initializers run),
 * `_tag` last for tagged forms; `message` on error forms is the Error base's slot. The constructor takes the
 * construct signature's props record (optional props are `T | undefined` slots). */
export function collectSchemaClass(L: Lowerer, decl: ts.ClassLikeDeclaration, schema: KernelSchemaClass,
  ctor: ts.ConstructorDeclaration | null, fields: Map<string, IrType>, fieldOrder: ClassInfo["fieldOrder"]): SchemaClassInfo {
  if (ctor) L.unsupported("SC1090", ctor, "a constructor on a schema class (the kernel synthesizes it from the props)");
  const isError = schema.form === "error" || schema.form === "taggedError";
  const symbol = ts.isClassDeclaration(decl) ? declSymbolOf(L, decl) : decl.name ? L.checker.getSymbolAtLocation(decl.name) : undefined;
  const instance = symbol ? L.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
  if (!instance) L.unsupported("SC1090", decl, "a schema class without an instance type");
  const props: { name: string; type: IrType }[] = [];
  const own: ClassInfo["fieldOrder"] = [];
  let messageProp = false;
  for (const prop of schema.fields.properties) {
    const key = ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined;
    const name = key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : null;
    if (name === null) L.unsupported("SC1090", prop, "schema class fields that are not literal-keyed property assignments");
    const member = L.checker.getPropertyOfType(instance, name);
    if (!member) L.unsupported("SC1090", prop, `the schema field '${name}' (no instance property)`);
    const tsType = L.checker.getTypeOfSymbolAtLocation(member, decl);
    const type = L.mapTypeOf(tsType);
    if (type === null) L.badType(prop, tsType);
    if (type.kind === "dyn") L.unsupported("SC1090", prop, `the schema prop '${name}' typed unknown (a dynamic class field has no native slot yet)`);
    if (isError && (name === "cause" || name === "name" || name === "stack")) L.unsupported("SC1090", prop, `the schema error field '${name}' (an Error slot the kernel does not carry)`);
    if (isError && name === "message") {
      if (type.kind !== "string") L.unsupported("SC1090", prop, "a non-string 'message' schema field");
      messageProp = true;
    } else if (fields.has(name)) {
      L.unsupported("SC1090", prop, `the schema field '${name}' (declared twice)`);
    } else {
      fields.set(name, type);
      own.push({ name, type, initializer: undefined });
    }
    props.push({ name, type });
  }
  if (schema.tag !== null) {
    fields.set("_tag", STRING);
    own.push({ name: "_tag", type: STRING, initializer: undefined });
  }
  fieldOrder.unshift(...own);
  // The props record: one field per prop, the instance's types (an optional prop is already `T | undefined`);
  // declaration order is the literal's. `_tag` never enters the props (the constructor stamps it).
  const propsType: IrType | null = props.length > 0
    ? { kind: "record", shapeId: L.shapes.intern([...props].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => ({ name: p.name, type: p.type })), false, undefined, props.map((p) => p.name)) }
    : null;
  return { form: schema.form, tag: schema.tag, identifier: schema.identifier, props, messageProp, propsType };
}

/** The schema class constructor's body: `new X(props)` — error forms first run the Error base's constructor
 * (message from the props, or "") and stamp `name` = tag / identifier; then each prop copies from the record,
 * `_tag` is stamped, and the body's own field initializers run. */
export function schemaCtorBody(L: Lowerer, info: ClassInfo, thisLocal: IrLocal, params: IrParam[]): IrStmt[] {
  const schema = info.schema!;
  const loc = locOf(info.decl!);
  const thisType: IrType = { kind: "object", className: info.def.name };
  const out: IrStmt[] = [];
  let props: IrExpr | null = null;
  if (schema.propsType !== null) {
    const local: IrLocal = { id: "props.0", name: "props", type: schema.propsType, mutable: false };
    L.ctx.locals.push(local);
    params.push({ localId: local.id, name: local.name, type: schema.propsType });
    props = { kind: "varRef", localId: local.id, type: schema.propsType, loc };
  }
  const shapeId = schema.propsType?.kind === "record" ? schema.propsType.shapeId : "";
  const read = (field: string, type: IrType): IrExpr => ({ kind: "recordGet", obj: props!, shapeId, field, type, loc });
  const lit = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
  const set = (field: string, value: IrExpr): IrStmt =>
    ({ kind: "fieldSet", obj: { kind: "varRef", localId: thisLocal.id, type: thisType, loc }, className: info.def.name, field, value, loc });
  const isError = schema.form === "error" || schema.form === "taggedError";
  if (isError) {
    out.push(L.superCallStmt(info, thisLocal, [schema.messageProp ? read("message", STRING) : lit("")], loc));
    out.push(set("name", lit(schema.tag ?? schema.identifier)));
  }
  for (const prop of schema.props) {
    if (isError && prop.name === "message") continue;
    out.push(set(prop.name, read(prop.name, prop.type)));
  }
  if (schema.tag !== null) out.push(set("_tag", lit(schema.tag)));
  out.push(...L.fieldInitStmts(info, thisLocal));
  return out;
}


/** The inspect helper's frame closures (lower-inspect.ts's inspectHelper), lent to the schema rendering. */
export interface SchemaInspectKit {
  depthGate(placeholder: string): IrStmt;
  begin(): IrStmt[];
  entry(s: IrExpr, isNum: IrExpr): IrStmt;
  child(type: IrType, value: IrExpr): IrExpr;
  end(base: IrExpr, open: IrExpr, close: IrExpr, arrayExtras: boolean, trailingMore: IrExpr): IrExpr;
  ret(value: IrExpr): IrStmt;
  v(): IrExpr;
  key(name: string): string;
}

/** A schema class prints like Effect's: data forms as `Name { props…, _tag }`, error forms as their toJSON object
 * `{ message?, props…, _tag }` (no bracket, no stack). Optional props holding undefined are omitted (an absent key in
 * Node; an explicit `undefined` at the construction site is the one divergence). */
export function schemaInspectBody(L: Lowerer, t: IrType & { kind: "object" }, info: ClassInfo, loc: SrcLoc, k: SchemaInspectKit): IrStmt[] {
  const schema = info.schema!;
  const display = info.decl?.name?.text ?? info.def.name.replace(/^%/, "");
  const isError = schema.form === "error" || schema.form === "taggedError";
  const entries = [
    ...(isError && schema.messageProp ? [{ name: "message", type: STRING as IrType }] : []),
    ...info.fieldOrder.filter((f) => !f.name.startsWith("#")).map((f) => ({ name: f.name, type: f.type })),
  ];
  if (entries.length === 0) return [k.ret(strLit(isError ? "{}" : `${display} {}`, loc))];
  const get = (field: string, type: IrType): IrExpr => ({ kind: "fieldGet", obj: k.v(), className: t.className, field, type, loc });
  const body: IrStmt[] = [k.depthGate(isError ? "[Object]" : `[${display}]`), ...k.begin()];
  for (const f of entries) {
    const text: IrExpr = { kind: "strConcat", left: strLit(`${k.key(f.name)}: `, loc), right: k.child(f.type, get(f.name, f.type)), type: STRING, loc };
    const push = k.entry(text, boolLit(false, loc));
    const u = f.type;
    const undefinedTag = u.kind === "union" ? L.armTag(u.unionId, UNDEFINED_T) : -1;
    body.push(u.kind === "union" && undefinedTag >= 0
      ? { kind: "if", cond: { kind: "unionIsTag", unionId: u.unionId, tag: undefinedTag, negated: true, value: get(f.name, u), type: BOOL, loc }, then: [push], else_: null, loc }
      : push);
  }
  body.push(k.ret(k.end(strLit("", loc), strLit(isError ? "{" : `${display} {`, loc), strLit("}", loc), false, boolLit(false, loc))));
  return body;
}

/** `return yield* Effect.fail(…)` in an Effect.gen body: the yield never resumes (its type is never) — the run ends
 * the fiber; what follows is unreachable, spelled as a throw for the backend's typing. Null for any other return. */
export function returnOfFailingYield(L: Lowerer, node: ts.Expression, loc: SrcLoc): IrStmt | null {
  if (!ts.isYieldExpression(node) || !node.asteriskToken || L.ctx.generator?.yieldT.kind !== "effect" || (L.typeOf(node).flags & ts.TypeFlags.Never) === 0) return null;
  const value = L.lowerExpr(node);
  return { kind: "block", body: [{ kind: "exprStmt", expr: value, loc }, { kind: "throw", value: strLit("scriptc: unreachable after a failing yield", loc), loc }], loc };
}

/* ── Schema VALUES ─────────────────────────────────────────────────────────────────────────────────────────────────
 * `Schema.String`, `Schema.Struct({…})`, `Schema.optional(…)`, filters and the decoders: the kernel's opaque handle
 * holding a descriptor (runtime/schema.rs); decoders are function values typed by the checker whose decoded dynamic
 * value converts to the site's `Type`. Kernel-typed method calls on handles (`S.make`, `S.annotate`, `S.check`,
 * `S.pipe(Schema.optional)`) are the identity or a wrap. */

function lib(fn: IrLibFn, args: IrExpr[], type: IrType, loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn, args, type, loc };
}

const SCHEMA_PRIMS: Record<string, string | undefined> = {
  String: "string", Number: "number", Boolean: "boolean", Unknown: "unknown", Any: "any", Finite: "finite", Int: "int",
  Null: "null", Undefined: "undefined", NumberFromString: "numberFromString",
};
const SCHEMA_WRAPS: Record<string, string | undefined> = {
  NullOr: "nullOr", UndefinedOr: "undefinedOr", optional: "optional", optionalKey: "optionalKey", mutable: "mutable", mutableKey: "mutableKey",
};
const SCHEMA_FILTERS_TEXT = new Set(["isStartsWith", "isEndsWith", "isIncludes"]);
const SCHEMA_FILTERS_NUMBER = new Set(["isGreaterThanOrEqualTo", "isLessThanOrEqualTo", "isGreaterThan", "isLessThan", "isMinLength", "isMaxLength"]);

/** `Schema.String` and the other primitive schema constants. */
export function lowerSchemaProperty(L: Lowerer, expr: ts.PropertyAccessExpression, loc: SrcLoc): IrExpr | null {
  // `Schema.UnknownFromJsonString`: JSON text in, the parsed value out.
  if (expr.name.text === "UnknownFromJsonString") {
    return lib("schema.wrap", [strLit("fromJsonString", loc), lib("schema.prim", [strLit("unknown", loc)], EFFECT_T, loc)], EFFECT_T, loc);
  }
  const prim = SCHEMA_PRIMS[expr.name.text];
  return prim === undefined ? null : lib("schema.prim", [strLit(prim, loc)], EFFECT_T, loc);
}

function wrap(kind: string, inner: IrExpr, loc: SrcLoc): IrExpr {
  return lib("schema.wrap", [strLit(kind, loc), inner], EFFECT_T, loc);
}

/** A schema HANDLE from a value: the handle itself, or a decorated schema record's hidden slot. */
export function unwrapSchema(L: Lowerer, value: IrExpr, node: ts.Node, what: string): IrExpr {
  if (value.type.kind === "effect") return value;
  if (value.type.kind === "record" && isDecoratedSchema(L.shapes, value.type)) {
    return { kind: "recordGet", obj: value, shapeId: value.type.shapeId, field: SCHEMA_SLOT, type: EFFECT_T, loc: value.loc };
  }
  return L.unsupported("SC1090", node, `${what} over a value that is not a schema handle`);
}

/** True when the expression's mapped type is a schema handle or a decorated schema record. */
export function isSchemaLike(L: Lowerer, node: ts.Expression): boolean {
  const type = L.mapTypeOf(L.typeOf(node));
  return type !== null && (type.kind === "effect" || isDecoratedSchema(L.shapes, type));
}

function handleArg(L: Lowerer, node: ts.Expression, what: string): IrExpr {
  return unwrapSchema(L, L.lowerExpr(node), node, what);
}

/** `Object.assign(schema, statics)` whose result is a decorated schema record: the record, with the source's fields
 * and the schema in the hidden slot. Null for any other Object.assign (the caller keeps its own rules). */
export function lowerObjectAssignSchema(L: Lowerer, call: ts.CallExpression): IrExpr | null {
  const [targetNode, sourceNode] = call.arguments;
  if (L.dynamic || targetNode === undefined || sourceNode === undefined || call.arguments.length !== 2 || !isSchemaLike(L, targetNode)) return null;
  const type = L.mapTypeOf(L.typeOf(call));
  if (type === null || type.kind !== "record" || !isDecoratedSchema(L.shapes, type)) return null;
  const loc = locOf(call);
  const shape = L.shapes.get(type.shapeId)!;
  const target = handleArg(L, targetNode, "Object.assign");
  const source = L.lowerExpr(sourceNode);
  const fields = shape.fields.map((field) => {
    if (field.name === SCHEMA_SLOT) return { name: field.name, value: target };
    const literal = source.kind === "recordLit" ? source.fields.find((f) => f.name === field.name)?.value : undefined;
    const value: IrExpr = literal ?? (source.type.kind === "record"
      ? { kind: "recordGet", obj: source, shapeId: source.type.shapeId, field: field.name, type: field.type, loc }
      : L.unsupported("SC1090", sourceNode, "Object.assign statics that are not a record"));
    return { name: field.name, value: L.coerceInto(sourceNode, value, field.type) };
  });
  return { kind: "recordLit", fields, type, loc };
}

/** A pipe step that is a PROGRAM function value (`.pipe(statics((s) => …))`, `.pipe(withRetry)`): the call of that
 * value with the accumulated source. Null when the step is not a one-parameter function. */
export function applyProgramPipeStep(L: Lowerer, source: IrExpr, step: ts.Expression, loc: SrcLoc): IrExpr | null {
  const fn = L.lowerExpr(step);
  const param = fn.type.kind === "func" ? fn.type.params[0] : undefined;
  if (fn.type.kind !== "func" || param === undefined || fn.type.params.length !== 1 || fn.type.rest !== undefined) return null;
  return { kind: "callValue", callee: fn, args: [L.coerceInto(step, source, param)], type: fn.type.ret, loc };
}

/** `Person.make(props)` on a schema CLASS: construction (effect's `make` is the constructor without `new`). */
export function lowerSchemaClassMake(L: Lowerer, receiver: ts.Expression, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const sym = (ts.isIdentifier(receiver) ? L.resolveValueSymbol(receiver) : ts.isPropertyAccessExpression(receiver) ? L.checker.getSymbolAtLocation(receiver.name) : undefined) ?? undefined;
  const aliased = sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0 ? L.checker.getAliasedSymbol(sym) : sym;
  const info = aliased === undefined ? undefined : L.classBySymbol.get(aliased);
  if (info === undefined || info.schema === undefined) return null;
  L.noteEdge(`%${info.def.name}.constructor`);
  const args = info.schema.propsType === null ? [] : L.completeArgs([...expr.arguments], info.ctorParams, loc, expr);
  return { kind: "new", className: info.def.name, args, type: { kind: "object", className: info.def.name }, loc };
}

/** A decoder function value: `(input: unknown, …) => R` typed by the checker; the Option/Effect/Exit forms carry
 * the decoded value type as an empty array literal of it (the emitter reads the element type). */
function decoder(L: Lowerer, fn: IrLibFn, schema: IrExpr, schemaNode: ts.Expression, expr: ts.Node, loc: SrcLoc): IrExpr {
  // The decoded value type is the schema's `Type` member (`S["Type"]`), as the checker resolves it.
  const typeMember = L.checker.getPropertyOfType(L.typeOf(schemaNode), "Type");
  const valueTs = typeMember === undefined ? undefined : L.checker.getTypeOfSymbolAtLocation(typeMember, schemaNode);
  const valueType = valueTs === undefined ? null : L.mapTypeOf(valueTs);
  if (valueType === null) L.unsupported("SC1090", expr, `a schema decoder whose decoded type '${valueTs === undefined ? "?" : L.checker.typeToString(valueTs)}' has no static shape`);
  // `Schema.is` answers a generic type predicate; the compiled value is one `(unknown) => boolean`.
  const type: IrType | null = fn === "schema.is" ? { kind: "func", params: [DYN], ret: BOOL } : L.mapTypeOf(L.typeOf(expr));
  if (type === null || type.kind !== "func") L.badType(expr, L.typeOf(expr));
  const args = [schema];
  if (fn === "schema.decodeOption" || fn === "schema.decodeEffect" || fn === "schema.decodeExit") {
    // The carrier stamps the decoded type as an empty array literal's element, so the type must be one an array can
    // hold — a checked-dynamic result (`Schema.Unknown`) has no such carrier yet.
    if (!isSupportedArrayElem(valueType)) {
      L.unsupported("SC1090", expr, `a schema decoder answering an Option/Effect/Exit of '${L.fmt(valueType)}' (the decoded type has no value carrier yet)`);
    }
    args.push({ kind: "arrayLit", elems: [], type: arrayOf(valueType), loc });
  }
  return lib(fn, args, type, loc);
}

/** `Schema.member(...)`: constructors, combinators, filters and decoders. */
export function lowerSchemaMember(L: Lowerer, member: string, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr {
  const first = args[0];
  const prim = SCHEMA_PRIMS[member];
  if (prim !== undefined && args.length === 0) return lib("schema.prim", [strLit(prim, loc)], EFFECT_T, loc);
  if (member === "Defect" && args.length === 0) return lib("schema.prim", [strLit("defect", loc)], EFFECT_T, loc);
  if (member === "tag" && first !== undefined && args.length === 1) {
    const literal = L.lowerExpr(first);
    if (literal.kind !== "strLit") L.unsupported("SC1090", first, "Schema.tag over a non-literal tag");
    return wrap(`tag:${literal.value}`, lib("schema.prim", [strLit("unknown", loc)], EFFECT_T, loc), loc);
  }
  const wrapKind = SCHEMA_WRAPS[member];
  if (wrapKind !== undefined && first !== undefined && args.length === 1) return wrap(wrapKind, handleArg(L, first, `Schema.${member}`), loc);
  if (member === "Literal" && first !== undefined && args.length === 1) {
    const value = L.lowerExpr(first);
    if (value.kind !== "strLit" && value.kind !== "numLit" && value.kind !== "boolLit") L.unsupported("SC1090", first, "Schema.Literal over a non-literal value");
    return lib("schema.literal", [{ kind: "arrayLit", elems: [value], type: arrayOf(value.type), loc }], EFFECT_T, loc);
  }
  if (member === "Literals" && first !== undefined && args.length === 1) {
    // The argument is a tuple to the checker: its elements lower one by one (a tuple literal is a record).
    if (!ts.isArrayLiteralExpression(first)) L.unsupported("SC1090", first, "Schema.Literals over a non-literal array");
    const elems = first.elements.map((e) => L.lowerExpr(e));
    if (elems.some((e) => e.kind !== "strLit" && e.kind !== "numLit" && e.kind !== "boolLit")) L.unsupported("SC1090", first, "Schema.Literals over non-literal members");
    return lib("schema.literal", [{ kind: "arrayLit", elems, type: arrayOf(elems[0]?.type ?? STRING), loc }], EFFECT_T, loc);
  }
  if (member === "Struct" && first !== undefined && args.length === 1) {
    if (!ts.isObjectLiteralExpression(first)) L.unsupported("SC1090", first, "Schema.Struct over a non-literal fields object");
    const fields = L.lowerExpr(first);
    if (fields.kind !== "recordLit" || fields.fields.some((f) => f.overflow !== undefined || f.drop !== undefined)) L.unsupported("SC1090", first, "Schema.Struct fields that are not schema handles");
    // The literal re-shapes over schema HANDLES (a decorated schema field unwraps to its slot): a fresh record whose
    // every field is a handle, in the literal's declared order.
    const order = fields.fields.map((f) => f.name);
    const shapeId = L.shapes.intern([...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((name) => ({ name, type: EFFECT_T as IrType })), false, undefined, order);
    const unwrapped: IrExpr = { kind: "recordLit", fields: fields.fields.map((f) => ({ name: f.name, value: unwrapSchema(L, f.value, first, "Schema.Struct") })), type: { kind: "record", shapeId }, loc };
    return lib("schema.struct", [unwrapped], EFFECT_T, loc);
  }
  if (member === "Array" && first !== undefined && args.length === 1) return lib("schema.array", [handleArg(L, first, "Schema.Array")], EFFECT_T, loc);
  if (member === "Record" && first !== undefined && args[1] !== undefined && args.length <= 3) {
    return lib("schema.record", [handleArg(L, first, "Schema.Record"), handleArg(L, args[1], "Schema.Record")], EFFECT_T, loc);
  }
  if (member === "Tuple" && first !== undefined && args.length === 1 && ts.isArrayLiteralExpression(first)) {
    const elems = first.elements.map((e) => handleArg(L, e, "Schema.Tuple"));
    return lib("schema.tuple", [{ kind: "arrayLit", elems, type: arrayOf(EFFECT_T), loc }], EFFECT_T, loc);
  }
  // `Schema.fromJsonString(S)`: the input is JSON TEXT, parsed before S validates it.
  if (member === "fromJsonString" && first !== undefined && args.length === 1) {
    return lib("schema.wrap", [strLit("fromJsonString", loc), handleArg(L, first, "Schema.fromJsonString")], EFFECT_T, loc);
  }
  if (member === "Union" && first !== undefined && args.length <= 2) {
    if (ts.isArrayLiteralExpression(first)) {
      const elems = first.elements.map((e) => handleArg(L, e, "Schema.Union"));
      return lib("schema.union", [{ kind: "arrayLit", elems, type: arrayOf(EFFECT_T), loc }], EFFECT_T, loc);
    }
    // A member ARRAY value (`Schema.Union(Definitions)`): an array of handles, or a tuple record of (decorated) handles.
    const members = L.lowerExpr(first);
    if (members.type.kind === "array" && members.type.elem.kind === "effect") return lib("schema.union", [members], EFFECT_T, loc);
    const shape = members.type.kind === "record" ? L.shapes.get(members.type.shapeId) : undefined;
    if (members.type.kind === "record" && shape?.tuple === true) {
      const shapeId = members.type.shapeId;
      const elems = shape.fields.map((field) => unwrapSchema(L, { kind: "recordGet", obj: members, shapeId, field: field.name, type: field.type, loc }, first, "Schema.Union"));
      return lib("schema.union", [{ kind: "arrayLit", elems, type: arrayOf(EFFECT_T), loc }], EFFECT_T, loc);
    }
    L.unsupported("SC1090", first, "Schema.Union over a value that is not an array or tuple of schemas");
  }
  if (SCHEMA_FILTERS_TEXT.has(member) && first !== undefined) {
    const text = L.lowerExprExpecting(first, STRING);
    return lib("schema.filter", [strLit(member, loc), numLit(0, loc), text], EFFECT_T, loc);
  }
  if (SCHEMA_FILTERS_NUMBER.has(member) && first !== undefined) {
    const number = L.lowerExprExpecting(first, { kind: "f64" });
    return lib("schema.filter", [strLit(member, loc), number, strLit("", loc)], EFFECT_T, loc);
  }
  // `Schema.isPattern(/re/)`: the literal's source and flags travel to the runtime's own regex engine.
  if (member === "isPattern" && first !== undefined) {
    const literal = ts.isRegularExpressionLiteral(first) ? first.text : null;
    if (literal === null) L.unsupported("SC1090", first, "Schema.isPattern over a value that is not a regular-expression literal");
    const lastSlash = literal.lastIndexOf("/");
    return lib("schema.filterPattern", [strLit(literal.slice(1, lastSlash), loc), strLit(literal.slice(lastSlash + 1), loc)], EFFECT_T, loc);
  }
  // `Schema.isBetween({ minimum, maximum })`: the inclusive range (the exclusive flags are not covered).
  if (member === "isBetween" && first !== undefined && ts.isObjectLiteralExpression(first)) {
    const numberOf = (name: string): IrExpr | null => {
      const found = first.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name);
      return found !== undefined && ts.isPropertyAssignment(found) ? L.lowerExprExpecting(found.initializer, { kind: "f64" }) : null;
    };
    const minimum = numberOf("minimum");
    const maximum = numberOf("maximum");
    if (minimum === null || maximum === null || first.properties.length !== 2) {
      L.unsupported("SC1090", first, "Schema.isBetween outside the inclusive { minimum, maximum } form");
    }
    return lib("schema.filterBetween", [minimum, maximum], EFFECT_T, loc);
  }
  if (member === "isInt" || member === "isFinite") return lib("schema.filter", [strLit(member, loc), numLit(0, loc), strLit("", loc)], EFFECT_T, loc);
  const decoders: Record<string, IrLibFn | undefined> = {
    decodeUnknownSync: "schema.decodeSync", decodeUnknownOption: "schema.decodeOption", decodeUnknownEffect: "schema.decodeEffect",
    decodeUnknownExit: "schema.decodeExit", is: "schema.is", encodeSync: "schema.encodeSync", encodeUnknownSync: "schema.encodeSync",
  };
  const fn = decoders[member];
  if (fn !== undefined && first !== undefined && args.length <= 2) return decoder(L, fn, handleArg(L, first, `Schema.${member}`), first, expr, loc);
  return L.unsupported("SC1090", expr, `the effect kernel does not cover Schema.${member} in this call shape yet`);
}

/** `Schema.is(S)(value)` called at once: one boolean, no predicate value (effect's predicate is a generic signature). */
export function lowerSchemaTest(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  const inner = expr.expression;
  if (!ts.isCallExpression(inner) || !ts.isPropertyAccessExpression(inner.expression) || !ts.isIdentifier(inner.expression.name) || inner.expression.name.text !== "is") return null;
  if (effectNamespaceOf(L, inner.expression.expression) !== "Schema" || inner.arguments.length !== 1 || expr.arguments.length !== 1) return null;
  return lib("schema.test", [handleArg(L, inner.arguments[0]!, "Schema.is"), L.lowerExprExpecting(expr.arguments[0]!, DYN)], BOOL, loc);
}

/** `S.pipe(Schema.optional)`, `S.pipe(Schema.brand("x"))`, `S.pipe(Schema.check(f))`, `S.pipe(Schema.mutable)`. */
export function applySchemaPipeStep(L: Lowerer, source: IrExpr, step: ts.Expression, loc: SrcLoc): IrExpr | null {
  if (ts.isPropertyAccessExpression(step) && ts.isIdentifier(step.name) && effectNamespaceOf(L, step.expression) === "Schema") {
    const kind = SCHEMA_WRAPS[step.name.text];
    if (kind !== undefined) return wrap(kind, source, loc);
    return L.unsupported("SC1090", step, `the effect kernel does not cover Schema.${step.name.text} as a pipe step yet`);
  }
  if (!ts.isCallExpression(step) || !ts.isPropertyAccessExpression(step.expression) || !ts.isIdentifier(step.expression.name) || effectNamespaceOf(L, step.expression.expression) !== "Schema") return null;
  const name = step.expression.name.text;
  if (name === "brand" && step.arguments.length === 1) return wrap("brand", source, loc);
  if (name === "toTaggedUnion" && step.arguments.length === 1) return source; // the union itself; its `cases`/`is*` helpers are not covered
  if (name === "check") return step.arguments.reduce<IrExpr>((acc, filter) => lib("schema.check", [acc, handleArg(L, filter, "Schema.check")], EFFECT_T, loc), source);
  // `Schema.decodeTo(Target, { decode: SchemaGetter.transform(f), encode: … })`: decode against the source, run the
  // program's `f`, then decode THAT against the target. Encoding is not modelled — `encodeSync` keeps its fence.
  if (name === "decodeTo" && step.arguments.length === 2 && step.arguments[1] !== undefined && ts.isObjectLiteralExpression(step.arguments[1]!)) {
    const options = step.arguments[1] as ts.ObjectLiteralExpression;
    const decodeProp = options.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "decode");
    if (decodeProp === undefined || !ts.isPropertyAssignment(decodeProp)) L.unsupported("SC1090", step, "Schema.decodeTo without a 'decode' getter");
    const getter = decodeProp.initializer;
    if (!ts.isCallExpression(getter) || !ts.isPropertyAccessExpression(getter.expression) || !ts.isIdentifier(getter.expression.name) ||
      getter.expression.name.text !== "transform" || getter.arguments.length !== 1) {
      L.unsupported("SC1090", step, `Schema.decodeTo whose decode getter is not 'SchemaGetter.transform(f)'`);
    }
    const transform = L.lowerExpr(getter.arguments[0]!);
    if (transform.type.kind !== "func" || transform.type.params.length !== 1) {
      L.unsupported("SC1090", step, "Schema.decodeTo whose transform is not a one-parameter function");
    }
    return lib("schema.decodeTo", [source, handleArg(L, step.arguments[0]!, "Schema.decodeTo"), transform], EFFECT_T, loc);
  }
  return L.unsupported("SC1090", step, `the effect kernel does not cover Schema.${name} as a pipe step yet`);
}

/** Methods on a schema handle: `S.make(props)` (the identity over the checker's Type), `S.annotate(…)` (the handle),
 * `S.check(f, …)`. Null for any other member (the caller keeps its fences). */
export function lowerSchemaHandleMethod(L: Lowerer, name: string, receiver: ts.Expression, args: ts.Expression[], expr: ts.Node, loc: SrcLoc): IrExpr | null {
  if (name === "make" && args.length >= 1 && args.length <= 2) {
    // The props travel as a dynamic value so the Struct's constructor defaults (`Schema.tag`) apply; the result is the Type.
    const type = L.mapTypeOf(L.typeOf(expr));
    if (type === null) L.badType(expr, L.typeOf(expr));
    return lib("schema.make", [handleArg(L, receiver, "make"), L.lowerExprExpecting(args[0]!, DYN)], type, loc);
  }
  if (name === "annotate" && args.length === 1) {
    // `annotate({ identifier: "X" })` names the schema in effect's messages; other annotations are not observable.
    const literal = args[0]!;
    const identifier = ts.isObjectLiteralExpression(literal)
      ? literal.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "identifier")
      : undefined;
    const source = handleArg(L, receiver, "annotate");
    if (identifier === undefined) return source;
    if (!ts.isStringLiteral(identifier.initializer)) L.unsupported("SC1090", identifier, "a non-literal schema identifier");
    return wrap(`identifier:${identifier.initializer.text}`, source, loc);
  }
  if (name === "check") return args.reduce<IrExpr>((acc, filter) => lib("schema.check", [acc, handleArg(L, filter, "check")], EFFECT_T, loc), handleArg(L, receiver, "check"));
  return null;
}
