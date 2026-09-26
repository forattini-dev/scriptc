import { F64, isRefCounted, type IrExpr, type IrFunction, type IrLocal, type IrModule, type IrRecordShape, type IrStmt, type IrType } from "./ir.js";

type Node = Record<string, unknown>;
const MAX_FIELDS = 4;
const MAX_CALLEE_NODES = 256;
const MAX_INLINE_NODES = 1024;

/** IR is a plain tree. Types and source locations are metadata, not uses. */
function everyNode(value: unknown, visit: (node: Node) => boolean): boolean {
  if (Array.isArray(value)) return value.every((v) => everyNode(v, visit));
  if (value === null || typeof value !== "object") return true;
  const node = value as Node;
  return visit(node) && Object.entries(node).every(([key, child]) =>
    key === "type" || key === "loc" || everyNode(child, visit));
}

function mapTree<T>(value: T, visit: (node: Node) => Node): T {
  if (Array.isArray(value)) return value.map((v) => mapTree(v, visit)) as T;
  if (value === null || typeof value !== "object") return value;
  const node = visit(value as Node);
  return Object.fromEntries(Object.entries(node).map(([key, child]) =>
    [key, key === "type" || key === "loc" ? child : mapTree(child, visit)])) as T;
}

interface Producer { fn: IrFunction; shape: IrRecordShape; size: number }

/** Splitting an expression frame must not shorten a reference temporary's
 * lifetime across later arguments, fields, or the original call itself. */
function scalarTemporaries(value: unknown): boolean {
  return everyNode(value, (node) => !node["type"] || !isRefCounted(node["type"] as IrType));
}

function producer(fn: IrFunction, shapes: ReadonlyMap<string, IrRecordShape>): Producer | null {
  if (fn.async || fn.generator || fn.captures?.length || fn.returnType.kind !== "record") return null;
  const shape = shapes.get(fn.returnType.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length === 0 || shape.fields.length > MAX_FIELDS ||
      shape.fields.some((f) => f.type.kind !== "f64")) return null;
  // Scalar parameters/locals need no ownership cleanup across the inlined
  // return. Closures, suspension and finally completions remain out of scope.
  if (fn.locals.some((l) => l.boxed || l.tdz || (l.type.kind !== "f64" && l.type.kind !== "bool")) ||
      fn.params.some((p) => p.type.kind !== "f64" && p.type.kind !== "bool")) return null;
  let size = 0;
  let returns = 0;
  const eligible = everyNode(fn.body, (node) => {
    if (typeof node["kind"] !== "string") return true;
    if (++size > MAX_CALLEE_NODES) return false;
    switch (node["kind"]) {
      case "closure": case "selfRef": case "tryCatch":
      case "awaitExpr": case "awaitUnionExpr": case "yieldExpr":
        return false;
      case "return": {
        returns++;
        const value = (node as Extract<IrStmt, { kind: "return" }>).value;
        return value?.kind === "recordLit" && value.type.kind === "record" && value.type.shapeId === shape.id &&
          value.fields.length === shape.fields.length && value.fields.every((f) =>
            !f.drop && !f.overflow && f.value.type.kind === "f64" && scalarTemporaries(f.value) && shape.fields.some((sf) => sf.name === f.name));
      }
      default: return true;
    }
  });
  return eligible && returns > 0 ? { fn, shape, size } : null;
}

/** A result may only be read through its declared scalar fields. Even an
 * apparently harmless alias, identity test, mutation or closure capture
 * keeps the original object. Count declarations too: no reinitialization. */
function fieldOnlyUses(fn: IrFunction, localId: string, shape: IrRecordShape): boolean {
  let declarations = 0;
  function visit(value: unknown): boolean {
    if (Array.isArray(value)) return value.every(visit);
    if (value === null || typeof value !== "object") return true;
    const node = value as Node;
    if (node["kind"] === "recordGet") {
      const read = node as Extract<IrExpr, { kind: "recordGet" }>;
      if (read.obj.kind === "varRef" && read.obj.localId === localId) {
        return read.shapeId === shape.id && read.type.kind === "f64" && shape.fields.some((f) => f.name === read.field);
      }
    }
    if (node["localId"] === localId) {
      if (node["kind"] !== "varDecl" || ++declarations !== 1) return false;
    }
    return Object.entries(node).every(([key, child]) => key === "type" || key === "loc" || visit(child));
  }
  return visit(fn.body) && declarations === 1;
}

interface Replacement {
  fields: Map<string, string>;
  body: IrStmt[];
}

/** Eliminate small fresh numeric result records at direct, field-only call
 * sites. This is a bounded shared backend pass, not a change to record ABI:
 * the original producer remains available to all other callers. Arguments
 * and literal fields retain source evaluation order. A labeled block models
 * return, including returns inside loops, without changing caller control
 * flow. Unknown uses and non-scalar producer locals keep the heap path. */
export function scalarizeNumericRecords(mod: IrModule): IrModule {
  const shapes = new Map((mod.records ?? []).map((s) => [s.id, s]));
  const producers = new Map<string, Producer>();
  for (const fn of mod.functions) {
    const p = producer(fn, shapes);
    if (p) producers.set(fn.name, p);
  }
  if (producers.size === 0) return mod;
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    if (fn.async || fn.generator) return fn;
    const locals = new Map(fn.locals.map((l) => [l.id, l]));
    const used = new Set([...locals.keys(), ...(mod.globals ?? []).map((g) => g.id)]);
    const loopHeaders = new Set<unknown>();
    everyNode(fn.body, (node) => {
      if (Array.isArray(node["labels"])) for (const label of node["labels"]) used.add(String(label));
      // A for header accepts one declaration/assignment, not the statement
      // block this pass produces. Leave those declarations on the heap path.
      if (node["kind"] === "for") { loopHeaders.add(node["init"]); loopHeaders.add(node["update"]); }
      return true;
    });
    let next = 0;
    const fresh = (): string => {
      let id: string;
      do { id = `%scalar.${next++}`; } while (used.has(id));
      used.add(id);
      return id;
    };
    const added: IrLocal[] = [];
    const replacements = new Map<string, Replacement>();
    let budget = MAX_INLINE_NODES;
    everyNode(fn.body, (node) => {
      if (node["kind"] !== "varDecl" || loopHeaders.has(node)) return true;
      const decl = node as Extract<IrStmt, { kind: "varDecl" }>;
      const local = locals.get(decl.localId);
      const call = decl.init;
      if (!local || local.mutable || local.boxed || local.tdz || local.type.kind !== "record" || call?.kind !== "call") return true;
      const p = producers.get(call.callee);
      if (!p || p.fn.name === fn.name || p.size > budget || p.shape.id !== local.type.shapeId ||
          call.args.length !== p.fn.params.length || !scalarTemporaries(call.args) || !fieldOnlyUses(fn, local.id, p.shape)) return true;
      budget -= p.size;
      for (const l of p.fn.locals) used.add(l.id);
      everyNode(p.fn.body, (n) => {
        if (Array.isArray(n["labels"])) for (const l of n["labels"]) used.add(String(l));
        return true;
      });
      const fields = new Map(p.shape.fields.map((f) => [f.name, fresh()]));
      const renamed = new Map(p.fn.locals.map((l) => [l.id, fresh()]));
      const labels = new Map<string, string>();
      const exit = fresh();
      const label = (name: string): string => {
        if (!labels.has(name)) labels.set(name, fresh());
        return labels.get(name)!;
      };
      for (const f of p.shape.fields) added.push({ id: fields.get(f.name)!, name: `${local.name}.${f.name}`, type: F64, mutable: true });
      for (const l of p.fn.locals) added.push({ ...l, id: renamed.get(l.id)! });
      const body = mapTree(p.fn.body, (n): Node => {
        if (n["kind"] === "return") {
          const ret = n as Extract<IrStmt, { kind: "return" }>;
          const literal = ret.value as Extract<IrExpr, { kind: "recordLit" }>;
          const assignments: IrStmt[] = literal.fields.map((f) => ({ kind: "assign", localId: fields.get(f.name)!, value: f.value, loc: ret.loc }));
          return { kind: "block", body: [...assignments, { kind: "break", label: exit, loc: ret.loc }], loc: ret.loc };
        }
        const out = { ...n };
        if (typeof out["localId"] === "string" && renamed.has(out["localId"])) out["localId"] = renamed.get(out["localId"]);
        if (typeof out["label"] === "string" && out["label"] !== exit) out["label"] = label(out["label"]);
        if (Array.isArray(out["labels"])) out["labels"] = out["labels"].map((l) => label(String(l)));
        return out;
      });
      const parameters: IrStmt[] = p.fn.params.map((param, i) => ({ kind: "varDecl", localId: renamed.get(param.localId)!, init: call.args[i]!, loc: decl.loc }));
      const declarations: IrStmt[] = [...fields.values()].map((id) => ({ kind: "varDecl", localId: id, init: null, loc: decl.loc }));
      replacements.set(local.id, { fields, body: [...declarations, { kind: "block", labels: [exit], body: [...parameters, ...body], loc: decl.loc }] });
      return true;
    });
    if (replacements.size === 0) return fn;
    changed = true;
    const body = mapTree(fn.body, (node): Node => {
      if (node["kind"] === "varDecl") {
        const decl = node as Extract<IrStmt, { kind: "varDecl" }>;
        const replacement = replacements.get(decl.localId);
        if (replacement) return { kind: "block", body: replacement.body, loc: decl.loc };
      }
      if (node["kind"] === "recordGet") {
        const read = node as Extract<IrExpr, { kind: "recordGet" }>;
        if (read.obj.kind === "varRef") {
          const id = replacements.get(read.obj.localId)?.fields.get(read.field);
          if (id) return { kind: "varRef", localId: id, type: F64, loc: read.loc };
        }
      }
      return node;
    });
    return { ...fn, locals: [...fn.locals.filter((l) => !replacements.has(l.id)), ...added], body };
  });
  return changed ? { ...mod, functions } : mod;
}
