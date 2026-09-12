import type { IrLocal, IrParam, IrStmt, IrType, SrcLoc } from "./ir.js";

export interface IrFunction {
  /** Original TS name (mangling is a backend concern). Lifted lambdas get
   * synthetic '%'-prefixed names ('%' can't appear in a TS identifier). */
  name: string;
  params: IrParam[];
  returnType: IrType;
  /** All locals including params, pre-collected and scope-flat: ids are
   * unique per function ("x.0", "x.1" for shadowing). The frontend resolves
   * lexical scoping; backends and future SSA both want exactly this. */
  locals: IrLocal[];
  /** Present on lifted functions that capture enclosing bindings: the boxed
   * variables received through the closure environment, in caps[] order.
   * Each is also listed in `locals` (with boxed: true); it is NOT a param. */
  captures?: IrParam[];
  /** Async: the body runs on a fiber; `returnType` is the INNER type T (a
   * `return v` fulfills with v) while call sites receive Promise<T>. */
  async?: true;
  /** Async module initializers only: a module-global Promise<T> slot where
   * the spawn wrapper caches its first evaluation promise. Every later
   * static/dynamic import receives that same promise, including while the
   * first evaluation is suspended. */
  asyncCacheGlobal?: string;
  /** Native synchronous ESM initializer evaluation record. The emitted
   * wrapper publishes a Promise<void> before the body, caches its exact
   * error on failure, and keeps static evaluation synchronous. */
  syncModuleCacheGlobal?: string;
  /** Async cyclic module initializers only: the SCC's shared Promise<T>
   * slot. Eager recursive spawning writes member promises from the inside
   * out, so the member that actually initiated evaluation writes last and
   * becomes the runtime cycle root. Dynamic imports wait on this shared
   * completion verdict instead of a build-time-selected member. */
  asyncCycleCacheGlobal?: string;
  /** Generator (`function*`): the body runs on a fiber created SUSPENDED
   * (nothing runs until the first `.next()`); `returnType` is the
   * generator's TReturn (VOID when it carries no value — `return;`
   * completes with the undefined arm) while call sites receive the
   * generator type `{ yieldT, retT: returnType, nextT }` from an emitted
   * spawn wrapper that only allocates. `yieldT` is what `yield e` sends
   * out, `nextT` what `.next(v)` sends in (the yield expression's result
   * type). Mutually exclusive with `async` (async generators are fenced). */
  generator?: { yieldT: IrType; nextT: IrType };
  body: IrStmt[];
  loc: SrcLoc;
}
