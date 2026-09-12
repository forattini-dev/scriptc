import type { IrExpr, IrFunction } from "../../ir/ir.js";

export interface RustByteReadInput {
  key: string;
  localId: string;
  projection?: Extract<IrExpr, { kind: "unionNarrow" }>;
}

export const rustByteLocalKey = (id: string): string => JSON.stringify([id]);

/** Recognize the successful path of a checked union projection from its IR,
 * never its function name. Failure paths are not moved: a nonmatching tag
 * selects ordinary loop emission, including its original exceptions/effects.
 * No calls, assignments or unknown conditions may run on the projected path. */
export function rustByteProjection(
  receiver: IrExpr,
  functions: ReadonlyMap<string, IrFunction>,
): RustByteReadInput | null {
  if (receiver.type.kind !== "bytes" || receiver.type.elem !== "u8") return null;
  if (receiver.kind === "varRef") return { key: rustByteLocalKey(receiver.localId), localId: receiver.localId };
  let projection: Extract<IrExpr, { kind: "unionNarrow" }>;
  if (receiver.kind === "unionNarrow") projection = receiver;
  else if (receiver.kind === "call") {
    const fn = functions.get(receiver.callee), argument = receiver.args[0];
    if (!fn || fn.async || fn.generator || fn.captures?.length || fn.syncModuleCacheGlobal ||
      fn.params.length !== 1 || receiver.args.length !== 1 || argument?.kind !== "varRef" ||
      fn.body.length > 16 || fn.locals.length !== 1) return null;
    const parameter = fn.params[0], local = fn.locals[0], last = fn.body.at(-1);
    if (!parameter || !local || local.id !== parameter.localId || local.boxed || local.tdz ||
      last?.kind !== "return" || last.value?.kind !== "unionNarrow" || last.value.value.kind !== "varRef" ||
      last.value.value.localId !== parameter.localId || parameter.type.kind !== "union" ||
      parameter.type.unionId !== last.value.unionId) return null;
    const result = last.value;
    for (const statement of fn.body.slice(0, -1)) {
      if (statement.kind !== "if" || statement.cond.kind !== "unionIsTag" ||
        statement.cond.unionId !== result.unionId || statement.cond.value.kind !== "varRef" ||
        statement.cond.value.localId !== parameter.localId || (statement.else_?.length ?? 0) !== 0) return null;
      const test = statement.cond.tag === result.tag;
      if (statement.cond.negated ? !test : test) return null;
    }
    projection = { ...result, value: argument };
  } else return null;
  const root = projection.value;
  if (projection.type.kind !== "bytes" || projection.type.elem !== "u8" || root.kind !== "varRef" ||
    root.type.kind !== "union" || root.type.unionId !== projection.unionId) return null;
  return { key: JSON.stringify([root.localId, projection.unionId, projection.tag]), localId: root.localId, projection };
}
