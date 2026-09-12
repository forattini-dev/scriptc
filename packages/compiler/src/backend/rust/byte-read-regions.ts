import type { IrExpr, IrFunction, IrLocal, IrStmt } from "../../ir/ir.js";

import { rustByteProjection, type RustByteReadInput } from "./byte-projections.js";

const scalarKinds = new Set(["f64", "bool", "string", "null", "undefined"]);
const structuralKinds = new Set([
  "numLit", "boolLit", "strLit", "nullLit", "undefinedLit", "varRef",
  "for", "while", "doWhile", "if", "switch", "block", "exprStmt", "return", "throw",
  "ternary", "logical", "nullish", "optChain", "chainRecv", "unionWrap", "unionNarrow", "unionIsTag",
  "strConcat",
]);

/** Prove that this region writes only its isolated output. Everything else,
 * including direct callees, must fit the read-only whitelist. Unknown IR,
 * indirect calls, shared writes and recursive calls fail closed. Input locals
 * must already exist, remain stable and not require a shared binding cell. */
export function rustByteReadInputs(
  stmt: IrStmt, output: string, fn: IrFunction,
  functions: ReadonlyMap<string, IrFunction>, isBoxed: (local: IrLocal) => boolean,
): RustByteReadInput[] {
  const inputs = new Map<string, RustByteReadInput>();
  const declared = new Set<string>();
  const visiting = new Set<string>([fn.name]);
  let budget = 20_000;

  function inspect(value: unknown, scope: IrFunction, region: boolean): boolean {
    if (--budget < 0) return false;
    if (Array.isArray(value)) return value.every(child => inspect(child, scope, region));
    if (value === null || typeof value !== "object") return true;
    const node = value as Record<string, unknown>;
    const kind = node.kind;
    if (typeof kind === "string") {
      if (kind === "bytesSet") {
        const receiver = node.arr as IrExpr;
        if (!region || receiver.kind !== "varRef" || receiver.localId !== output) return false;
      } else if (kind === "bytesIntrinsic") {
        if (!["get", "length", "byteLength"].includes(String(node.method))) return false;
        const receiver = node.receiver as IrExpr;
        const input = region ? rustByteProjection(receiver, functions) : null;
        if (input !== null && input.localId !== output) inputs.set(input.key, input);
      } else if (kind === "varDecl" || kind === "assign" || kind === "incDec") {
        const local = scope.locals.find(local => local.id === node.localId);
        if (!local || !scalarKinds.has(local.type.kind) || local.boxed || local.tdz) return false;
        if (kind === "varDecl" && region) declared.add(local.id);
      } else if (kind === "call") {
        const callee = functions.get(String(node.callee));
        if (!callee || callee.async || callee.generator || callee.captures?.length ||
          callee.syncModuleCacheGlobal || visiting.has(callee.name) || visiting.size >= 16) return false;
        visiting.add(callee.name);
        const safe = inspect(callee.body, callee, false);
        visiting.delete(callee.name);
        if (!safe) return false;
      } else if (kind === "libCall") {
        if (node.fn !== "math.abs" && node.fn !== "math.floor" && node.fn !== "math.ceil" && node.fn !== "error.new") return false;
        if (!(node.args as IrExpr[]).every(arg => scalarKinds.has(arg.type.kind))) return false;
      } else if (kind === "bin") {
        if (![node.left, node.right].every(arg => scalarKinds.has((arg as IrExpr).type.kind))) return false;
      } else if (kind === "unary" || kind === "toString") {
        if (!scalarKinds.has((node.operand as IrExpr).type.kind)) return false;
      } else if (kind === "break" || kind === "continue") {
        if (node.label !== undefined) return false;
      } else if (!structuralKinds.has(kind)) return false;
      if (kind === "varRef" && !scope.locals.some(local => local.id === node.localId)) return false;
    }
    return Object.entries(node).every(([key, child]) => key === "type" || key === "loc" || inspect(child, scope, region));
  }
  if (!inspect(stmt, fn, true)) return [];
  return [...inputs.values()].filter(input => {
    const id = input.localId;
    const local = fn.locals.find(local => local.id === id);
    return local !== undefined && (input.projection !== undefined ||
      (local.type.kind === "bytes" && local.type.elem === "u8")) &&
      !declared.has(id) && !local.tdz && !isBoxed(local);
  });
}
