import type { IrFunction } from "../../ir/ir.js";
import { mangleFunction } from "../mangle.js";
import type { RustDefinitionContext } from "./definitions.js";
import { isSharedRecord } from "./shared-records.js";

/** The frontend retains a typed identity helper for frozen fresh records.
 * Only shared storage needs runtime metadata: a later Proxy observes it. */
export function emitSharedProxyRestriction(context: RustDefinitionContext, fn: IrFunction): boolean {
  if (!/^%rec\.proxyRestricted\.\d+$/.test(fn.name) || fn.params.length !== 1 || fn.captures !== undefined || fn.async || fn.generator) return false;
  const type = fn.params[0]?.type;
  if (type?.kind !== "record" || !isSharedRecord(context.records.get(type.shapeId)) || context.records.get(type.shapeId)?.tuple) return false;
  const boxed = context.emitDynFromValue(type, "sc_input.clone()", fn.loc);
  const rust = context.rustType(type);
  context.line(`fn ${mangleFunction(fn.name)}(sc_input: ${rust}) -> ${rust} { let _ = sc_dyn_mark_proxy_restricted(${boxed}); sc_input }`);
  return true;
}
