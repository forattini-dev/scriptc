/* Kernel SCHEMA CLASSES (Schema.Class / ErrorClass / TaggedClass / TaggedErrorClass) as native classes: the props are
 * synthesized fields, the constructor takes the props record, error forms root at the runtime Error, and instances
 * print like Effect's. lower-classes.ts collects, lower-inspect.ts renders, lowerer.ts's return handles a failing yield. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import type { KernelSchemaClass } from "../kernel.js";
import { BOOL, IrExpr, IrLocal, IrParam, IrStmt, IrType, STRING, SrcLoc, UNDEFINED_T } from "../../ir/nodes.js";
import { boolLit, strLit } from "../../ir/build.js";
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
