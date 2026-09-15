import type { IrFunction, SrcLoc } from "../../ir/ir.js";
import { mangleFunction } from "../mangle.js";
import type { RustClassMeta } from "./model.js";

/** What the Error `message` getter dispatch needs from the emitter. */
export interface ErrorMessageGetterContext {
  readonly classMeta: ReadonlyMap<string, RustClassMeta>;
  readonly functions: ReadonlyMap<string, IrFunction>;
  classFieldName(className: string, field: string, loc?: SrcLoc): string;
  nextName(prefix: string): string;
  unsupported(message: string, loc?: SrcLoc): never;
}

/** The nearest `get message()` implementation at or above `meta`, if any. */
function messageGetterOf(context: ErrorMessageGetterContext, meta: RustClassMeta): IrFunction | null {
  for (let current: RustClassMeta | null = meta; current !== null; current = current.base) {
    if (!current.def.methods?.includes("get:message")) continue;
    const fn = context.functions.get(`%${current.def.name}.get:message`);
    if (fn === undefined) context.unsupported(`missing Error message getter '${current.def.name}'`, current.def.loc);
    return fn;
  }
  return null;
}

/** `.message` on an Error-rooted instance whose class subtree declares
 * `get message()` (schema error classes without a `message` prop): the
 * kernel stamps no own message, so the getter shadows the Error base's
 * message slot. The read dispatches on the dynamic class — getter classes
 * call their implementation, every other class reads the slot. Null when
 * no class at or below `meta` resolves a getter (the plain slot read). */
export function emitErrorMessageRead(context: ErrorMessageGetterContext, meta: RustClassMeta, slotOwner: string, receiver: string): string | null {
  const slot = context.classFieldName(slotOwner, "message");
  if (!meta.hierarchy) {
    const fn = messageGetterOf(context, meta);
    return fn === null ? null : `${mangleFunction(fn.name)}(${receiver})`;
  }
  const getters = new Map<string, { fn: IrFunction; tags: number[] }>();
  for (const candidate of context.classMeta.values()) {
    if (candidate.root !== meta.root || candidate.pre < meta.pre || candidate.pre > meta.post || candidate.def.abstract) continue;
    const fn = messageGetterOf(context, candidate);
    if (fn === null) continue;
    const entry = getters.get(fn.name);
    if (entry === undefined) getters.set(fn.name, { fn, tags: [candidate.pre] });
    else entry.tags.push(candidate.pre);
  }
  if (getters.size === 0) return null;
  const value = context.nextName("sc_rt");
  const arms = [...getters.values()].map(({ fn, tags }) => `${tags.join(" | ")} => ${mangleFunction(fn.name)}(${value}.clone()),`).join(" ");
  return `{ let ${value} = ${receiver}; match ${value}.with(|object| object.sc_class_pre) { ${arms} _ => ${value}.with(|object| object.${slot}.clone()), } }`;
}
