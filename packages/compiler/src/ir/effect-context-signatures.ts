import { DYN, EFFECT_T, F64, STRING } from "./type-constants.js";

export type IrEffectContextLibFn =
  /** `Context.Reference(id, { defaultValue })`: a service key whose lookup answers the (lazily computed, then
   * cached) default when no provide installed a value. */
  | "effect.referenceKey"
  /** `Effect.withFiber((fiber) => effect)`: the callback receives the running fiber's context snapshot. */
  | "effect.withFiber"
  /** `Fiber.getCurrent()`: the running fiber's context snapshot (the kernel's fiber value). */
  | "effect.fiberCurrent"
  /** `Context.get/getUnsafe(context, key)`: the service (or reference default), typed by the site. Throws when absent. */
  | "effect.contextGet"
  /** `Context.getOption(context, key)`: an Option handle. */
  | "effect.contextGetOption"
  /** `Effect.serviceOption(key)`: an effect answering the Option of the service in scope. */
  | "effect.serviceOption"
  /** `Scope.Scope`: the key a context snapshot answers with its innermost open scope. */
  | "effect.scopeKey"
  /** `Scope.addFinalizer(scope, effect)`: registers the finalizer in that scope. */
  | "effect.scopeAddFinalizer"
  /** `semaphore.take(n)` / `semaphore.release(n)`. */
  | "effect.semaphoreTake"
  | "effect.semaphoreRelease"
  /** `Effect.uninterruptibleMask((restore) => effect)`: the kernel has no interruption, so the callback runs lazily
   * with `restore` bound to the identity closure (the second argument). */
  | "effect.uninterruptibleMask"
  /** effect/unstable/sql, natively (effect_sql.rs). `Statement.makeCompilerSqlite(...)`: an inert compiler handle (the
   * kernel runs SQL text as given). */
  | "effect.sqlCompiler"
  /** `SqlClient.SafeIntegers`: the reference key, default false. */
  | "effect.sqlSafeIntegers"
  /** `SqlClient.make({ acquirer, transactionAcquirer? })`: acquirer, transaction acquirer, and the `record:<shape>`
   * carrier naming the program's Connection record (the generated adapter calls its methods). */
  | "effect.sqlClientMake"
  /** `client.unsafe(sql, params)`: a statement handle. */
  | "effect.sqlUnsafe"
  /** A statement's execution effect: `withoutTransform` / `values` / `raw` / `unprepared` (the string argument). */
  | "effect.sqlRun"
  /** `client.withTransaction(effect)`: BEGIN/SAVEPOINT, the body with the transaction connection, COMMIT/ROLLBACK. */
  | "effect.sqlWithTransaction"
  /** `client.transactionService`: the per-client transaction key. */
  | "effect.sqlTransactionKey"
  /** `client.reserve`: the transaction acquirer. */
  | "effect.sqlReserve";

export const EFFECT_CONTEXT_LIB_FN_SIGS = {
  "effect.referenceKey": { argTypes: [STRING, null], result: EFFECT_T },
  "effect.withFiber": { argTypes: [null], result: EFFECT_T },
  "effect.fiberCurrent": { argTypes: [], result: EFFECT_T },
  "effect.contextGet": { argTypes: [EFFECT_T, EFFECT_T], result: EFFECT_T },
  "effect.contextGetOption": { argTypes: [EFFECT_T, EFFECT_T], result: EFFECT_T },
  "effect.serviceOption": { argTypes: [EFFECT_T], result: EFFECT_T },
  "effect.scopeKey": { argTypes: [], result: EFFECT_T },
  "effect.scopeAddFinalizer": { argTypes: [EFFECT_T, EFFECT_T], result: EFFECT_T },
  "effect.semaphoreTake": { argTypes: [EFFECT_T, F64], result: EFFECT_T },
  "effect.semaphoreRelease": { argTypes: [EFFECT_T, F64], result: EFFECT_T },
  "effect.uninterruptibleMask": { argTypes: [null, null], result: EFFECT_T },
  "effect.sqlCompiler": { argTypes: [], result: EFFECT_T },
  "effect.sqlSafeIntegers": { argTypes: [], result: EFFECT_T },
  "effect.sqlClientMake": { argTypes: [EFFECT_T, EFFECT_T, STRING], result: EFFECT_T },
  "effect.sqlUnsafe": { argTypes: [EFFECT_T, STRING, DYN], result: EFFECT_T },
  "effect.sqlRun": { argTypes: [EFFECT_T, STRING], result: EFFECT_T },
  "effect.sqlWithTransaction": { argTypes: [EFFECT_T, EFFECT_T], result: EFFECT_T },
  "effect.sqlTransactionKey": { argTypes: [EFFECT_T], result: EFFECT_T },
  "effect.sqlReserve": { argTypes: [EFFECT_T], result: EFFECT_T },
};
