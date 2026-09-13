import type { IrFunction, IrType } from "../../ir/ir.js";
import { mangleFunction } from "../mangle.js";
import type { RustDefinitionContext } from "./definitions.js";
import { isSharedRecord } from "./shared-records.js";

/** Membership on a shared view observes the original object. In particular,
 * a lazy typed Proxy must reach the explicit HasProperty/GetOwnProperty
 * refusal instead of folding a declared field to true or invoking Get. */
export function emitSharedMembership(context: RustDefinitionContext, fn: IrFunction): boolean {
  const own = /^%obj\.hasOwn\.\d+$/.test(fn.name);
  const inherited = /^%rec\.(?:haskey|hasIn|hasInUnion)\.\d+$/.test(fn.name);
  if ((!own && !inherited) || fn.params.length !== 2 || fn.captures !== undefined || fn.async || fn.generator) return false;
  const source = fn.params[own ? 0 : 1]?.type;
  const key = fn.params[own ? 1 : 0]?.type;
  const shared = (type: IrType): boolean => type.kind === "record"
    ? isSharedRecord(context.records.get(type.shapeId)) && !context.records.get(type.shapeId)?.tuple
    : type.kind === "union" && (context.unions.get(type.unionId)?.arms.some(shared) ?? false);
  if (!source || key?.kind !== "string" || fn.returnType.kind !== "bool" || !shared(source)) return false;
  const recordParam = `sc_input: ${context.rustType(source)}`;
  const keyParam = "sc_key: runtime::JsString";
  const boxed = context.emitDynFromValue(source, "sc_input", fn.loc);
  context.line(`fn ${mangleFunction(fn.name)}(${(own ? [recordParam, keyParam] : [keyParam, recordParam]).join(", ")}) -> bool { let sc_value = ${boxed}; sc_dyn_${own ? "has_own" : "has_key"}(&sc_value, &sc_key) }`);
  return true;
}
