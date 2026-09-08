import type { IrFunction, IrGlobal, IrType, SrcLoc } from "./nodes.js";
import { typeEquals, typeKey, VOID } from "./nodes.js";

/** Evaluation caches are module-owned mutable promise slots. */
export function validateModuleInitCaches(
  fn: IrFunction,
  globals: Map<string, IrGlobal>,
  err: (message: string, loc: SrcLoc) => void,
): void {
  const asyncCaches = [
    ["asyncCacheGlobal", fn.asyncCacheGlobal],
    ["asyncCycleCacheGlobal", fn.asyncCycleCacheGlobal],
  ] as const;
  for (const [field, cacheId] of asyncCaches) {
    if (cacheId === undefined) continue;
    if (fn.async !== true) {
      err(`an ${field} is only valid on an async function`, fn.loc);
    }
    if (fn.params.length !== 0 || (fn.captures?.length ?? 0) !== 0) {
      err("a cached async function must have no parameters or captures", fn.loc);
    }
    const cache = globals.get(cacheId);
    if (cache === undefined) {
      err(`async cache names undeclared global "${cacheId}"`, fn.loc);
    } else {
      const expected: IrType = { kind: "promise", inner: fn.returnType };
      if (!typeEquals(cache.type, expected)) {
        err(
          `async cache global "${cacheId}" has type ${typeKey(cache.type)}, expected ${typeKey(expected)}`,
          fn.loc,
        );
      }
      if (!cache.mutable) {
        err(`async cache global "${cacheId}" is immutable`, fn.loc);
      }
    }
  }
  if (fn.asyncCycleCacheGlobal !== undefined && fn.asyncCacheGlobal === undefined) {
    err("an asyncCycleCacheGlobal requires a module asyncCacheGlobal", fn.loc);
  }

  const syncId = fn.syncModuleCacheGlobal;
  if (syncId === undefined) return;
  if (fn.async === true || fn.generator !== undefined || fn.returnType.kind !== "void" ||
      fn.params.length !== 0 || (fn.captures?.length ?? 0) !== 0 ||
      fn.asyncCacheGlobal !== undefined || fn.asyncCycleCacheGlobal !== undefined) {
    err("a syncModuleCacheGlobal requires a synchronous void initializer without parameters or captures", fn.loc);
  }
  const cache = globals.get(syncId);
  const expected: IrType = { kind: "promise", inner: VOID };
  if (cache === undefined) {
    err(`sync module cache names undeclared global "${syncId}"`, fn.loc);
  } else {
    if (!typeEquals(cache.type, expected)) {
      err(`sync module cache global "${syncId}" has type ${typeKey(cache.type)}, expected ${typeKey(expected)}`, fn.loc);
    }
    if (!cache.mutable) err(`sync module cache global "${syncId}" is immutable`, fn.loc);
  }
}
