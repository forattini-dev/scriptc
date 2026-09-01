import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { mangleLocal } from "../mangle.js";
import { emitAwaitDependency } from "./async-await.js";
import { asyncTrampolineCall } from "./async-trampoline.js";
import type { IrAwaitExpr } from "./model.js";
import { rustAsyncExpressionOperands } from "./async-values.js";
import { emitAsyncProtectedWhile } from "./async-protected-loop.js";

export interface RustAsyncHandlers {
  readonly fallthrough: () => void;
  readonly returned: (value: string) => void;
  readonly thrown: (reason: string) => void;
}

type RustAsyncCompletion =
  | { readonly kind: "fallthrough" }
  | { readonly kind: "return"; readonly value: string }
  | { readonly kind: "throw"; readonly reason: string };

interface RustAsyncLoopControl {
  breakLoop(): void;
  continueLoop(): void;
}

export interface RustAsyncControlContext {
  readonly records: ReadonlyMap<string, IrRecordShape>;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextName(prefix: string): string;
  currentAsyncResult(): string | null;
  currentFunction(): IrFunction | null;
  currentAsyncLocals(): Set<string> | null;
  setCurrentAsyncLocals(locals: Set<string> | null): void;
  adjustAsyncProtectedReturnDepth(delta: number): void;
  emitExpr(expr: IrExpr): string;
  emitExprWithValues(expr: IrExpr, values: readonly (readonly [IrExpr, string])[]): string;
  emitStatement(statement: IrStmt): void;
  emitAssignment(id: string, value: string, loc: SrcLoc): void;
  emitAsyncValue(expr: IrExpr, consume: (value: string) => void): void;
  emitAsyncContinuation(
    dependencyExpr: string,
    consume: (value: string) => void,
    remaining: readonly IrStmt[] | null,
    onComplete?: (() => void) | null,
  ): void;
  emitAsyncProtectedValues(
    exprs: readonly IrExpr[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (values: string[]) => void,
    index?: number,
    values?: string[],
  ): void;
  emitAsyncProtectedRecordCloneOverrides(
    expr: Extract<IrExpr, { kind: "recordClone" }>,
    clone: string,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: () => void,
    index?: number,
  ): void;
  emitAsyncConsole(
    expr: Extract<IrExpr, { kind: "intrinsic" }>,
    remaining: readonly IrStmt[],
    index: number,
    values: { name: string; type: IrType; loc: SrcLoc }[],
    onComplete: (() => void) | null,
  ): void;
  emitBinaryValues(expr: Extract<IrExpr, { kind: "bin" }>, left: string, right: string): string;
  emitArrayGetValues(expr: Extract<IrExpr, { kind: "arrayGet" }>, array: string, index: string): string;
  emitBytesNewValue(expr: Extract<IrExpr, { kind: "bytesNew" }>, source: string | null): string;
  emitArrayIntrinsicValues(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>, receiver: string, args: readonly string[]): string;
  emitMapIntrinsicValues(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>, receiver: string, args: readonly string[]): string;
  emitRecordCloneInitial(expr: Extract<IrExpr, { kind: "recordClone" }>, source: string): string;
  emitRecordCloneOverride(expr: Extract<IrExpr, { kind: "recordClone" }>, clone: string, name: string, value: string): string;
  emitToStringValue(type: IrType, operand: string, loc: SrcLoc): string;
  displayValue(value: string, type: IrType, loc: SrcLoc): string;
  local(id: string, loc: SrcLoc): IrFunction["locals"][number];
  needsClone(type: IrType): boolean;
  isEdgeValue(type: IrType): boolean;
  isUnit(type: IrType): boolean;
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export class RustAsyncControlEmitter {
  private loopControl: RustAsyncLoopControl | null = null;

  constructor(private readonly context: RustAsyncControlContext) {}

  containsAsyncSuspension(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => this.containsAsyncSuspension(item));
    const node = value as { kind?: unknown; fn?: unknown; name?: unknown };
    if (node.kind === "awaitExpr" || node.kind === "awaitUnionExpr") return true;
    if (node.kind === "libCall" && node.fn === "async.hop") return true;
    if (node.kind === "intrinsic" && node.name === "module.await") return true;
    return Object.values(value).some((item) => this.containsAsyncSuspension(item));
  }

  awaitExpression(expr: IrExpr | null): IrAwaitExpr | null {
    return expr?.kind === "awaitExpr" || expr?.kind === "awaitUnionExpr" ? expr : null;
  }

  asyncHopSequence(expr: IrExpr | null): {
    prelude: readonly IrStmt[];
    result: IrExpr;
  } | null {
    if (expr?.kind !== "seqExpr") return null;
    const hop = expr.stmts.findIndex((candidate) =>
      candidate.kind === "exprStmt" && candidate.expr.kind === "libCall" && candidate.expr.fn === "async.hop"
    );
    if (hop < 0) return null;
    if (hop !== expr.stmts.length - 1 || expr.result.kind !== "varRef" ||
      this.containsAsyncSuspension(expr.stmts.slice(0, hop))) {
      this.context.unsupported("non-canonical await-value hop", expr.loc);
    }
    return { prelude: expr.stmts.slice(0, hop), result: expr.result };
  }

  awaitedValue(expr: IrExpr | null): { awaited: IrAwaitExpr; wrap: (value: string) => string } | null {
    const awaited = this.awaitExpression(expr);
    if (awaited !== null) return { awaited, wrap: (value) => value };
    if (expr?.kind !== "unionWrap") return null;
    const inner = this.awaitedValue(expr.value);
    if (inner === null) return null;
    const union = this.context.union(expr.unionId, expr.loc);
    const arm = union.arms[expr.tag];
    if (arm === undefined || this.context.isUnit(arm)) {
      this.context.unsupported(`awaited union wrapper '${expr.unionId}:${expr.tag}'`, expr.loc);
    }
    const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(expr.tag)}`;
    return { awaited: inner.awaited, wrap: (value) => `${variant}(${inner.wrap(value)})` };
  }

  emitAwaitDependency(expr: IrAwaitExpr): string {
    return emitAwaitDependency(this.context, expr);
  }

  emitAsyncStatements(statements: readonly IrStmt[], onComplete: (() => void) | null = null): void {
    const result = this.context.currentAsyncResult();
    const fn = this.context.currentFunction();
    if (result === null || fn?.async !== true) this.context.unsupported("async continuation outside an async function", fn?.loc);

    for (let index = 0; index < statements.length; index += 1) {
      const stmt = statements[index];
      if (stmt === undefined) break;
      if (stmt.kind === "break" || stmt.kind === "continue") {
        if (stmt.label !== undefined || this.loopControl === null) {
          this.context.unsupported(`${stmt.kind} outside a supported suspended async loop`, stmt.loc);
        }
        if (stmt.kind === "break") this.loopControl.breakLoop();
        else this.loopControl.continueLoop();
        return;
      }
      if (stmt.kind === "while" && this.containsAsyncSuspension(stmt.body)) {
        this.emitAsyncWhile(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      if (stmt.kind === "forOf" &&
        (this.containsAsyncSuspension(stmt.iterable) || this.containsAsyncSuspension(stmt.body))) {
        this.emitAsyncForOf(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      if (stmt.kind === "for" && this.containsAsyncSuspension(stmt.body)) {
        this.emitAsyncFor(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      if (stmt.kind === "block" && (this.containsAsyncSuspension(stmt.body) ||
        (this.loopControl !== null && this.containsLoopControl(stmt.body)))) {
        const outerLocals = new Set(this.context.currentAsyncLocals() ?? []);
        const resume = this.emitAsyncResumeHelper(
          statements.slice(index + 1),
          onComplete,
          outerLocals,
          stmt.loc,
          "block_continue",
        );
        this.withAsyncLocals(new Set(outerLocals), () => this.emitAsyncStatements(stmt.body, resume));
        return;
      }
      if (stmt.kind === "if" && (this.containsAsyncSuspension(stmt) ||
        (this.loopControl !== null && this.containsLoopControl(stmt)))) {
        this.emitAsyncIf(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      if (stmt.kind === "tryCatch" && this.containsAsyncSuspension(stmt)) {
        this.emitAsyncTryCatch(stmt, statements.slice(index + 1), onComplete);
        return;
      }
      const nested =
        stmt.kind === "assign" ? stmt.value
        : stmt.kind === "varDecl" ? stmt.init
        : stmt.kind === "exprStmt" ? stmt.expr
        : stmt.kind === "return" ? stmt.value
        : null;
      if (stmt.kind === "exprStmt" && stmt.expr.kind === "intrinsic" &&
        stmt.expr.name === "module.await") {
        const argument = stmt.expr.args[0];
        if (argument === undefined) this.context.unsupported("module.await without a dependency", stmt.loc);
        const dependency = this.context.nextName("sc_module_dependency");
        const outcome = this.context.nextName("sc_module_outcome");
        this.context.line(`let ${dependency} = ${this.context.emitExpr(argument)};`);
        this.context.line(`if let Some(${outcome}) = runtime::promise_poll(&${dependency}) {`);
        this.context.pushIndent();
        this.context.line(`let _ = runtime::promise_unwrap(${outcome});`);
        this.context.popIndent();
        this.context.line("} else {");
        this.context.pushIndent();
        this.context.emitAsyncContinuation(
          dependency,
          (value) => this.context.line(`let _ = ${value};`),
          statements.slice(index + 1),
          onComplete,
        );
        this.context.popIndent();
        this.context.line("}");
        continue;
      }
      const hop = this.asyncHopSequence(nested);
      if (hop !== null) {
        for (const prelude of hop.prelude) {
          this.context.emitStatement(prelude);
          if (prelude.kind === "varDecl") this.context.currentAsyncLocals()?.add(prelude.localId);
        }
        this.context.emitAsyncContinuation(
          "runtime::promise_resolved(())",
          (rawValue) => {
            this.context.line(`let _ = ${rawValue};`);
            const value = this.context.emitExpr(hop.result);
            if (stmt.kind === "assign") {
              this.context.emitAssignment(stmt.localId, value, stmt.loc);
            } else if (stmt.kind === "varDecl") {
              const local = this.context.local(stmt.localId, stmt.loc);
              this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = runtime::cell_new(${value});`);
              this.context.currentAsyncLocals()?.add(local.id);
            } else if (stmt.kind === "exprStmt") {
              this.context.line(`let _ = ${value};`);
            } else {
              this.context.line(`let _ = runtime::promise_fulfill(&${result}, ${value});`);
              this.context.line("return;");
            }
          },
          stmt.kind === "return" ? null : statements.slice(index + 1),
          onComplete,
        );
        return;
      }
      if (stmt.kind === "exprStmt" && stmt.expr.kind === "intrinsic" &&
        (stmt.expr.name === "console.log" || stmt.expr.name === "console.error") &&
        stmt.expr.args.some((arg) => this.containsAsyncSuspension(arg))) {
        this.context.emitAsyncConsole(stmt.expr, statements.slice(index + 1), 0, [], onComplete);
        return;
      }
      const awaited = this.awaitedValue(
        stmt.kind === "assign" ? stmt.value
        : stmt.kind === "varDecl" ? stmt.init
        : stmt.kind === "exprStmt" ? stmt.expr
        : stmt.kind === "return" ? stmt.value
        : null,
      );
      if (awaited === null) {
        if (nested !== null && ((nested.kind === "bin" || nested.kind === "nullish" || nested.kind === "toString" || nested.kind === "strConcat" ||
          nested.kind === "seqExpr" || nested.kind === "ternary" ||
          nested.kind === "recordLit" || nested.kind === "recordClone" || nested.kind === "arrayGet" || nested.kind === "bytesNew" ||
          nested.kind === "arrIntrinsic" || nested.kind === "mapIntrinsic") || rustAsyncExpressionOperands(nested) !== null) &&
          this.containsAsyncSuspension(nested)) {
          this.context.emitAsyncValue(nested, (value) => {
            if (stmt.kind === "assign") {
              this.context.emitAssignment(stmt.localId, value, stmt.loc);
              this.emitAsyncStatements(statements.slice(index + 1), onComplete);
            } else if (stmt.kind === "varDecl") {
              const local = this.context.local(stmt.localId, stmt.loc);
              this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = runtime::cell_new(${value});`);
              this.context.currentAsyncLocals()?.add(local.id);
              this.emitAsyncStatements(statements.slice(index + 1), onComplete);
            } else if (stmt.kind === "exprStmt") {
              this.context.line(`let _ = ${value};`);
              this.emitAsyncStatements(statements.slice(index + 1), onComplete);
            } else {
              this.context.line(`let _ = runtime::promise_fulfill(&${result}, ${value});`);
              this.context.line("return;");
            }
          });
          return;
        }
        if (this.containsAsyncSuspension(stmt)) {
          this.context.unsupported("nested async suspension in the Rust state-machine subset", stmt.loc);
        }
        this.context.emitStatement(stmt);
        if (stmt.kind === "varDecl") this.context.currentAsyncLocals()?.add(stmt.localId);
        continue;
      }

      const continueAwait = (dependency: string): void => this.context.emitAsyncContinuation(
        dependency,
        (rawValue) => {
          const value = awaited.wrap(rawValue);
          if (stmt.kind === "assign") {
            this.context.emitAssignment(stmt.localId, value, stmt.loc);
          } else if (stmt.kind === "varDecl") {
            const local = this.context.local(stmt.localId, stmt.loc);
            this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = runtime::cell_new(${value});`);
            this.context.currentAsyncLocals()?.add(local.id);
          } else if (stmt.kind === "exprStmt") {
            this.context.line(`let _ = ${value};`);
          } else {
            this.context.line(`let _ = runtime::promise_fulfill(&${result}, ${value});`);
            this.context.line("return;");
          }
        },
        stmt.kind === "return" ? null : statements.slice(index + 1),
        onComplete,
      );
      if (
        awaited.awaited.kind === "awaitExpr" &&
        this.containsAsyncSuspension(awaited.awaited.value)
      ) {
        this.context.emitAsyncValue(awaited.awaited.value, continueAwait);
      } else {
        continueAwait(this.emitAwaitDependency(awaited.awaited));
      }
      return;
    }

    if (onComplete !== null) {
      onComplete();
    } else if (fn.returnType.kind === "void") {
      this.context.line(`let _ = runtime::promise_fulfill(&${result}, ());`);
    } else {
      this.context.line(`unreachable!("scriptc invariant: async function '${this.context.rustString(fn.name)}' fell through");`);
    }
  }

  emitAsyncTryCatch(
    stmt: Extract<IrStmt, { kind: "tryCatch" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    const outerLocals = new Set(this.context.currentAsyncLocals() ?? []);
    const resume = this.emitAsyncResumeHelper(remaining, onComplete, outerLocals, stmt.loc, "try_continue");
    this.emitAsyncProtectedSequence(stmt.tryBody, outerLocals, {
      fallthrough: () => this.emitAsyncFinally(stmt, [], outerLocals, { kind: "fallthrough" }, resume),
      returned: (value) => this.emitAsyncFinally(stmt, [], outerLocals, { kind: "return", value }, resume),
      thrown: (reason) => this.emitAsyncCatch(stmt, [], outerLocals, reason, resume),
    }, stmt.loc);
  }

  emitAsyncIf(
    stmt: Extract<IrStmt, { kind: "if" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    const outerLocals = new Set(this.context.currentAsyncLocals() ?? []);
    const resume = this.emitAsyncResumeHelper(remaining, onComplete, outerLocals, stmt.loc, "if_continue");
    const emitBranches = (condition: string): void => {
      this.context.line(`if ${condition} {`);
      this.context.pushIndent();
      this.withAsyncLocals(new Set(outerLocals), () => this.emitAsyncStatements(stmt.then, resume));
      this.context.popIndent();
      this.context.line("} else {");
      this.context.pushIndent();
      const elseBody = stmt.else_;
      if (elseBody === null) {
        resume();
      } else {
        this.withAsyncLocals(new Set(outerLocals), () => this.emitAsyncStatements(elseBody, resume));
      }
      this.context.popIndent();
      this.context.line("}");
    };
    if (this.containsAsyncSuspension(stmt.cond)) {
      this.context.emitAsyncValue(stmt.cond, emitBranches);
      return;
    }
    emitBranches(this.context.emitExpr(stmt.cond));
  }

  emitAsyncFor(
    stmt: Extract<IrStmt, { kind: "for" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    const result = this.context.currentAsyncResult();
    const fn = this.context.currentFunction();
    if (result === null || fn?.async !== true) this.context.unsupported("async for outside an async function", stmt.loc);
    if ((stmt.labels?.length ?? 0) > 0) this.context.unsupported("labeled async for", stmt.loc);
    if (this.containsAsyncSuspension(stmt.init) || this.containsAsyncSuspension(stmt.cond) ||
      this.containsAsyncSuspension(stmt.update)) {
      this.context.unsupported("async suspension in for init, condition, or update", stmt.loc);
    }
    if (stmt.init !== null) {
      this.context.emitStatement(stmt.init);
      if (stmt.init.kind === "varDecl") this.context.currentAsyncLocals()?.add(stmt.init.localId);
    }
    const outerLoopControl = this.loopControl;
    const loopLocals = new Set(this.context.currentAsyncLocals() ?? []);
    const helper = this.context.nextName("sc_async_loop");
    const locals = [...loopLocals].map((localId) => this.context.local(localId, stmt.loc));
    const resultType = this.context.rustType(fn.returnType, stmt.loc);
    const params = [
      `${result}: runtime::JsPromise<${resultType}>`,
      ...locals.map((local) =>
        `${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}>`
      ),
    ];
    const call = () => asyncTrampolineCall(this.context, helper, [
      `${result}.clone()`,
      ...locals.map((local) => `${mangleLocal(local.id)}.clone()`),
    ]);
    this.context.line(`fn ${helper}(${params.join(", ")}) {`);
    this.context.pushIndent();
    this.withAsyncLocals(new Set(loopLocals), () => {
      this.context.line(`if ${stmt.cond === null ? "true" : this.context.emitExpr(stmt.cond)} {`);
      this.context.pushIndent();
      const continueLoop = () => this.withAsyncLocals(new Set(loopLocals), () => {
        if (stmt.update !== null) this.context.emitStatement(stmt.update);
        this.context.line(call());
        this.context.line("return;");
      });
      this.withLoopControl({
        breakLoop: () => this.withAsyncLocals(new Set(loopLocals), () =>
          this.withLoopControl(outerLoopControl, () => this.emitAsyncStatements(remaining, onComplete))),
        continueLoop,
      }, () => this.emitAsyncStatements(stmt.body, continueLoop));
      this.context.popIndent();
      this.context.line("} else {");
      this.context.pushIndent();
      this.withLoopControl(outerLoopControl, () => this.emitAsyncStatements(remaining, onComplete));
      this.context.popIndent();
      this.context.line("}");
    });
    this.context.popIndent();
    this.context.line("}");
    this.context.line(call());
    this.context.line("return;");
  }

  emitAsyncWhile(
    stmt: Extract<IrStmt, { kind: "while" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
  ): void {
    const result = this.context.currentAsyncResult();
    const fn = this.context.currentFunction();
    if (result === null || fn?.async !== true) this.context.unsupported("async while outside an async function", stmt.loc);
    if ((stmt.labels?.length ?? 0) > 0) this.context.unsupported("labeled async while", stmt.loc);
    if (this.containsAsyncSuspension(stmt.cond)) this.context.unsupported("async suspension in a while condition", stmt.loc);
    const outerLoopControl = this.loopControl;
    const loopLocals = new Set(this.context.currentAsyncLocals() ?? []);
    const locals = [...loopLocals].map((localId) => this.context.local(localId, stmt.loc));
    const helper = this.context.nextName("sc_async_while");
    const params = [
      `${result}: runtime::JsPromise<${this.context.rustType(fn.returnType, stmt.loc)}>`,
      ...locals.map((local) =>
        `${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}>`
      ),
    ];
    const args = [
      `${result}.clone()`,
      ...locals.map((local) => `${mangleLocal(local.id)}.clone()`),
    ];
    const call = stmt.cond.kind === "boolLit" && stmt.cond.value
      ? `${helper}(${args.join(", ")});`
      : asyncTrampolineCall(this.context, helper, args);

    this.context.line(`fn ${helper}(${params.join(", ")}) {`);
    this.context.pushIndent();
    this.withAsyncLocals(new Set(loopLocals), () => {
      this.context.line(`if ${this.context.emitExpr(stmt.cond)} {`);
      this.context.pushIndent();
      const continueLoop = () => this.withAsyncLocals(new Set(loopLocals), () => {
        this.context.line(call);
        this.context.line("return;");
      });
      this.withLoopControl({
        breakLoop: () => this.withAsyncLocals(new Set(loopLocals), () =>
          this.withLoopControl(outerLoopControl, () => this.emitAsyncStatements(remaining, onComplete))),
        continueLoop,
      }, () => this.emitAsyncStatements(stmt.body, continueLoop));
      this.context.popIndent();
      this.context.line("} else {");
      this.context.pushIndent();
      this.withLoopControl(outerLoopControl, () => this.emitAsyncStatements(remaining, onComplete));
      this.context.popIndent();
      this.context.line("}");
    });
    this.context.popIndent();
    this.context.line("}");
    this.context.line(call);
    this.context.line("return;");
  }

  emitAsyncForOf(
    stmt: Extract<IrStmt, { kind: "forOf" }>,
    remaining: readonly IrStmt[],
    onComplete: (() => void) | null,
    arrayValue?: string,
  ): void {
    const result = this.context.currentAsyncResult();
    const fn = this.context.currentFunction();
    if (result === null || fn?.async !== true) this.context.unsupported("async for-of outside an async function", stmt.loc);
    if ((stmt.labels?.length ?? 0) > 0) this.context.unsupported("labeled async for-of", stmt.loc);
    if (stmt.iterable.type.kind !== "array") this.context.unsupported("async for-of over a non-array", stmt.loc);
    if (arrayValue === undefined && this.containsAsyncSuspension(stmt.iterable)) {
      this.context.emitAsyncValue(stmt.iterable, (value) =>
        this.emitAsyncForOf(stmt, remaining, onComplete, value));
      return;
    }
    if (this.containsLoopControl(stmt.body)) {
      this.context.unsupported("break or continue in a suspended async for-of", stmt.loc);
    }

    const loopLocals = new Set(this.context.currentAsyncLocals() ?? []);
    const locals = [...loopLocals].map((localId) => this.context.local(localId, stmt.loc));
    const local = this.context.local(stmt.localId, stmt.loc);
    const helper = this.context.nextName("sc_async_for_of");
    const array = this.context.nextName("sc_async_for_of_array");
    const index = this.context.nextName("sc_async_for_of_index");
    const params = [
      `${result}: runtime::JsPromise<${this.context.rustType(fn.returnType, stmt.loc)}>`,
      `${array}: ${this.context.rustType(stmt.iterable.type, stmt.loc)}`,
      `${index}: f64`,
      ...locals.map((candidate) =>
        `${mangleLocal(candidate.id)}: runtime::JsCell<${this.context.rustType(candidate.type, stmt.loc)}>`
      ),
    ];
    const call = (nextIndex: string) => asyncTrampolineCall(this.context, helper, [
      `${result}.clone()`,
      `${array}.clone()`,
      nextIndex,
      ...locals.map((candidate) => `${mangleLocal(candidate.id)}.clone()`),
    ]);

    this.context.line(`let ${array} = ${arrayValue ?? this.context.emitExpr(stmt.iterable)};`);
    this.context.line(`fn ${helper}(${params.join(", ")}) {`);
    this.context.pushIndent();
    this.withAsyncLocals(new Set(loopLocals), () => {
      this.context.line(`if ${index} < runtime::array_len(&${array}) {`);
      this.context.pushIndent();
      this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`);
      const iterationLocals = new Set(loopLocals);
      iterationLocals.add(local.id);
      this.withAsyncLocals(iterationLocals, () => {
        this.emitAsyncStatements(stmt.body, () => this.withAsyncLocals(new Set(loopLocals), () => {
          this.context.line(call(`${index} + 1.0_f64`));
          this.context.line("return;");
        }));
      });
      this.context.popIndent();
      this.context.line("} else {");
      this.context.pushIndent();
      this.withAsyncLocals(new Set(loopLocals), () => this.emitAsyncStatements(remaining, onComplete));
      this.context.popIndent();
      this.context.line("}");
    });
    this.context.popIndent();
    this.context.line("}");
    this.context.line(call("0.0_f64"));
    this.context.line("return;");
  }

  containsLoopControl(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((item) => this.containsLoopControl(item));
    const node = value as { kind?: unknown };
    if (node.kind === "break" || node.kind === "continue") return true;
    return Object.values(value).some((item) => this.containsLoopControl(item));
  }

  withLoopControl<T>(
    control: RustAsyncLoopControl | null,
    emit: () => T,
  ): T {
    const previous = this.loopControl;
    this.loopControl = control;
    try {
      return emit();
    } finally {
      this.loopControl = previous;
    }
  }

  emitAsyncProtectedSequence(
    statements: readonly IrStmt[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    loc: SrcLoc,
  ): void {
    const blockIndex = statements.findIndex((statement) =>
      statement.kind === "block" && this.containsAsyncSuspension(statement.body)
    );
    const block = statements[blockIndex];
    if (blockIndex >= 0 && block?.kind === "block") {
      this.emitAsyncProtectedSequence([
        ...statements.slice(0, blockIndex),
        ...block.body,
        ...statements.slice(blockIndex + 1),
      ], exitLocals, handlers, loc);
      return;
    }
    const result = this.context.currentAsyncResult();
    const fn = this.context.currentFunction();
    if (result === null || fn?.async !== true) this.context.unsupported("async protected segment without a result promise", loc);
    const segment = this.context.nextName("sc_async_segment");
    this.context.line(`let ${segment} = runtime::promise_try_segment::<${this.context.rustType(fn.returnType, loc)}, _>(|| {`);
    this.context.pushIndent();
    let terminal: "await" | "return" | null = null;
    this.withAsyncLocals(new Set(this.context.currentAsyncLocals() ?? []), () => {
      for (let index = 0; index < statements.length; index += 1) {
        const current = statements[index];
        if (current === undefined) break;
        if (current.kind === "while" && this.containsAsyncSuspension(current.body)) {
          emitAsyncProtectedWhile(
            this.context,
            (...args) => this.emitAsyncProtectedSequence(...args),
            (locals, emit) => this.withAsyncLocals(locals, emit),
            current,
            statements.slice(index + 1),
            exitLocals,
            handlers,
            loc,
          );
          this.context.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        if (current.kind === "forOf" &&
          (this.containsAsyncSuspension(current.iterable) || this.containsAsyncSuspension(current.body))) {
          this.emitAsyncProtectedForOf(
            current,
            statements.slice(index + 1),
            exitLocals,
            handlers,
            loc,
          );
          this.context.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        if (current.kind === "exprStmt" && current.expr.kind === "intrinsic" &&
          (current.expr.name === "console.log" || current.expr.name === "console.error") &&
          current.expr.args.some((arg) => this.containsAsyncSuspension(arg))) {
          this.emitAsyncProtectedConsole(
            current.expr,
            statements.slice(index + 1),
            exitLocals,
            handlers,
            loc,
          );
          this.context.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        if (current.kind === "arraySet" && this.containsAsyncSuspension(current)) {
          this.context.emitAsyncProtectedValues([current.arr, current.index, current.value], exitLocals, handlers, (values) => {
            this.context.line(`runtime::array_set(&(${values[0]}), ${values[1]}, ${values[2]});`);
            this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
          });
          this.context.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        const nested =
          current.kind === "assign" ? current.value
          : current.kind === "varDecl" ? current.init
          : current.kind === "exprStmt" ? current.expr
          : current.kind === "return" ? current.value
          : null;
        const awaited = this.awaitedValue(nested);
        if (awaited !== null) {
          this.emitAsyncProtectedContinuation(
            this.emitAwaitDependency(awaited.awaited),
            exitLocals,
            handlers,
            (value) => {
              const completedValue = awaited.wrap(value);
              if (current.kind === "assign") {
                this.context.emitAssignment(current.localId, completedValue, current.loc);
                this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
              } else if (current.kind === "varDecl") {
                const local = this.context.local(current.localId, current.loc);
                this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, current.loc)}> = runtime::cell_new(${completedValue});`);
                this.context.currentAsyncLocals()?.add(local.id);
                this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
              } else if (current.kind === "exprStmt") {
                this.context.line(`let _ = ${completedValue};`);
                this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
              } else {
                this.withAsyncLocals(new Set(exitLocals), () => handlers.returned(completedValue));
              }
            },
          );
          this.context.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        if (nested !== null && ((nested.kind === "unionWrap" || nested.kind === "bin" ||
          nested.kind === "toString" || nested.kind === "strConcat" ||
          nested.kind === "arrayGet" || nested.kind === "bytesNew" ||
          nested.kind === "mapIntrinsic" || nested.kind === "recordClone") ||
          rustAsyncExpressionOperands(nested) !== null) &&
          this.containsAsyncSuspension(nested)) {
          this.emitAsyncProtectedValue(nested, exitLocals, handlers, (value) => {
            if (current.kind === "assign") {
              this.context.emitAssignment(current.localId, value, current.loc);
              this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
            } else if (current.kind === "varDecl") {
              const local = this.context.local(current.localId, current.loc);
              this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, current.loc)}> = runtime::cell_new(${value});`);
              this.context.currentAsyncLocals()?.add(local.id);
              this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
            } else if (current.kind === "exprStmt") {
              this.context.line(`let _ = ${value};`);
              this.emitAsyncProtectedSequence(statements.slice(index + 1), exitLocals, handlers, loc);
            } else {
              this.withAsyncLocals(new Set(exitLocals), () => handlers.returned(value));
            }
          });
          this.context.line("return runtime::AsyncCompletion::Suspended;");
          terminal = "await";
          break;
        }
        if (this.containsAsyncSuspension(current)) {
          this.context.unsupported("nested async suspension inside a Rust protected segment", current.loc);
        }
        if (current.kind === "return") {
          const value = current.value === null ? "()" : this.context.emitExpr(current.value);
          this.context.line(`return runtime::AsyncCompletion::Return(${value});`);
          terminal = "return";
          break;
        }
        this.context.adjustAsyncProtectedReturnDepth(1);
        try {
          this.context.emitStatement(current);
        } finally {
          this.context.adjustAsyncProtectedReturnDepth(-1);
        }
        if (current.kind === "varDecl") this.context.currentAsyncLocals()?.add(current.localId);
      }
    });
    if (terminal === null) this.context.line("runtime::AsyncCompletion::Fallthrough");
    this.context.popIndent();
    this.context.line("});");
    this.context.line(`match ${segment} {`);
    this.context.pushIndent();
    if (terminal === null) {
      this.context.line("Ok(runtime::AsyncCompletion::Fallthrough) => {");
      this.context.pushIndent();
      this.withAsyncLocals(new Set(exitLocals), handlers.fallthrough);
      this.context.popIndent();
      this.context.line("},");
      this.context.line("Ok(runtime::AsyncCompletion::Return(value)) => {");
      this.context.pushIndent();
      this.withAsyncLocals(new Set(exitLocals), () => handlers.returned("value"));
      this.context.popIndent();
      this.context.line("},");
      this.context.line("Ok(runtime::AsyncCompletion::Suspended) => unreachable!(\"scriptc invariant: invalid async fallthrough completion\"),");
    } else if (terminal === "return") {
      this.context.line("Ok(runtime::AsyncCompletion::Return(value)) => {");
      this.context.pushIndent();
      this.withAsyncLocals(new Set(exitLocals), () => handlers.returned("value"));
      this.context.popIndent();
      this.context.line("},");
      this.context.line("Ok(runtime::AsyncCompletion::Fallthrough) | Ok(runtime::AsyncCompletion::Suspended) => unreachable!(\"scriptc invariant: invalid async return completion\"),");
    } else {
      this.context.line("Ok(runtime::AsyncCompletion::Suspended) => {},");
      this.context.line("Ok(runtime::AsyncCompletion::Return(value)) => {");
      this.context.pushIndent();
      this.withAsyncLocals(new Set(exitLocals), () => handlers.returned("value"));
      this.context.popIndent();
      this.context.line("},");
      this.context.line("Ok(runtime::AsyncCompletion::Fallthrough) => unreachable!(\"scriptc invariant: invalid async suspension completion\"),");
    }
    this.context.line("Err(reason) => {");
    this.context.pushIndent();
    this.withAsyncLocals(new Set(exitLocals), () => handlers.thrown("reason"));
    this.context.popIndent();
    this.context.line("},");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("return;");
  }

  emitAsyncProtectedContinuation(
    dependencyExpr: string,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (value: string) => void,
  ): void {
    const result = this.context.currentAsyncResult();
    if (result === null) {
      this.context.unsupported("protected async continuation without a result promise", this.context.currentFunction()?.loc);
    }
    const dependency = this.context.nextName("sc_async_dependency");
    const nextResult = this.context.nextName("sc_async_result");
    const outcome = this.context.nextName("sc_async_outcome");
    const guard = this.context.nextName("sc_async_guard");
    const value = this.context.nextName("sc_async_value");
    this.context.line(`let ${dependency} = ${dependencyExpr};`);
    this.context.line(`let ${nextResult} = ${result}.clone();`);
    const continuationLocals = new Set(this.context.currentAsyncLocals() ?? []);
    const captures = [...continuationLocals].map((localId) => ({
      localId,
      capture: this.context.nextName("sc_async_capture"),
    }));
    for (const capture of captures) {
      this.context.line(`let ${capture.capture} = ${mangleLocal(capture.localId)}.clone();`);
    }
    this.context.line(`runtime::promise_then(&${dependency}, Box::new(move |${outcome}| {`);
    this.context.pushIndent();
    this.context.line(`let ${guard} = ${nextResult}.clone();`);
    this.context.line(`runtime::promise_run_segment(&${guard}, move || {`);
    this.context.pushIndent();
    this.context.line(`let ${result} = ${nextResult};`);
    for (const capture of captures) {
      this.context.line(`let ${mangleLocal(capture.localId)} = ${capture.capture};`);
    }
    this.context.line(`match ${outcome} {`);
    this.context.pushIndent();
    this.context.line(`Ok(${value}) => {`);
    this.context.pushIndent();
    this.withAsyncLocals(new Set(continuationLocals), () => consume(value));
    this.context.popIndent();
    this.context.line("},");
    this.context.line("Err(reason) => {");
    this.context.pushIndent();
    this.withAsyncLocals(new Set(exitLocals), () => handlers.thrown("reason"));
    this.context.popIndent();
    this.context.line("},");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("});");
    this.context.popIndent();
    this.context.line("}));");
  }

  emitAsyncProtectedValue(
    expr: IrExpr,
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    consume: (value: string) => void,
  ): void {
    const awaited = this.awaitExpression(expr);
    if (awaited !== null) {
      this.emitAsyncProtectedContinuation(this.emitAwaitDependency(awaited), exitLocals, handlers, consume);
      return;
    }
    if (expr.kind === "unionWrap" && this.containsAsyncSuspension(expr.value)) {
      const union = this.context.union(expr.unionId, expr.loc);
      const arm = union.arms[expr.tag];
      if (arm === undefined || this.context.isUnit(arm)) {
        this.context.unsupported(`protected async union wrapper '${expr.unionId}:${expr.tag}'`, expr.loc);
      }
      const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(expr.tag)}`;
      this.emitAsyncProtectedValue(
        expr.value,
        exitLocals,
        handlers,
        (value) => consume(`${variant}(${value})`),
      );
      return;
    }
    if (expr.kind === "bin") {
      this.emitAsyncProtectedValue(expr.left, exitLocals, handlers, (left) => {
        this.emitAsyncProtectedValue(
          expr.right,
          exitLocals,
          handlers,
          (right) => consume(this.context.emitBinaryValues(expr, left, right)),
        );
      });
      return;
    }
    if (expr.kind === "toString") {
      this.emitAsyncProtectedValue(
        expr.operand,
        exitLocals,
        handlers,
        (value) => consume(this.context.emitToStringValue(expr.operand.type, value, expr.loc)),
      );
      return;
    }
    if (expr.kind === "strConcat") {
      this.emitAsyncProtectedValue(expr.left, exitLocals, handlers, (left) => {
        this.emitAsyncProtectedValue(
          expr.right,
          exitLocals,
          handlers,
          (right) => consume(`runtime::string_concat(&(${left}), &(${right}))`),
        );
      });
      return;
    }
    if (expr.kind === "arrayGet") {
      this.emitAsyncProtectedValue(expr.arr, exitLocals, handlers, (array) => {
        this.emitAsyncProtectedValue(
          expr.index,
          exitLocals,
          handlers,
          (index) => consume(this.context.emitArrayGetValues(expr, array, index)),
        );
      });
      return;
    }
    if (expr.kind === "bytesNew" && expr.source !== null) {
      this.emitAsyncProtectedValue(
        expr.source,
        exitLocals,
        handlers,
        (source) => consume(this.context.emitBytesNewValue(expr, source)),
      );
      return;
    }
    if (expr.kind === "mapIntrinsic") {
      this.emitAsyncProtectedValue(expr.receiver, exitLocals, handlers, (receiver) => {
        this.context.emitAsyncProtectedValues(expr.args, exitLocals, handlers, (args) => {
          consume(this.context.emitMapIntrinsicValues(expr, receiver, args));
        });
      });
      return;
    }
    if (expr.kind === "recordClone") {
      this.emitAsyncProtectedValue(expr.source, exitLocals, handlers, (source) => {
        const clone = this.context.nextName("sc_async_record_clone");
        this.context.line(`let ${clone} = ${this.context.emitRecordCloneInitial(expr, source)};`);
        this.context.emitAsyncProtectedRecordCloneOverrides(
          expr,
          clone,
          exitLocals,
          handlers,
          () => consume(clone),
        );
      });
      return;
    }
    const operands = rustAsyncExpressionOperands(expr);
    if (operands !== null && operands.some((operand) => this.containsAsyncSuspension(operand))) {
      this.context.emitAsyncProtectedValues(operands, exitLocals, handlers, (values) => {
        consume(this.context.emitExprWithValues(
          expr,
          operands.map((operand, index) => [
            operand,
            values[index] ?? this.context.unsupported("missing async expression operand", operand.loc),
          ] as const),
        ));
      });
      return;
    }
    if (this.containsAsyncSuspension(expr)) {
      this.context.unsupported("nested async value inside a Rust protected segment", expr.loc);
    }
    const value = this.context.nextName("sc_async_value");
    this.context.line(`let ${value} = ${this.context.emitExpr(expr)};`);
    consume(value);
  }

  emitAsyncProtectedForOf(
    stmt: Extract<IrStmt, { kind: "forOf" }>,
    remaining: readonly IrStmt[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    loc: SrcLoc,
    arrayValue?: string,
  ): void {
    const result = this.context.currentAsyncResult();
    const fn = this.context.currentFunction();
    if (result === null || fn?.async !== true) {
      this.context.unsupported("protected async for-of outside an async function", stmt.loc);
    }
    if ((stmt.labels?.length ?? 0) > 0) this.context.unsupported("labeled protected async for-of", stmt.loc);
    if (stmt.iterable.type.kind !== "array") this.context.unsupported("protected async for-of over a non-array", stmt.loc);
    if (arrayValue === undefined && this.containsAsyncSuspension(stmt.iterable)) {
      this.emitAsyncProtectedValue(stmt.iterable, exitLocals, handlers, (value) =>
        this.emitAsyncProtectedForOf(stmt, remaining, exitLocals, handlers, loc, value));
      return;
    }
    if (this.containsLoopControl(stmt.body)) {
      this.context.unsupported("break or continue in a protected suspended async for-of", stmt.loc);
    }

    const loopLocals = new Set(this.context.currentAsyncLocals() ?? []);
    const locals = [...loopLocals].map((localId) => this.context.local(localId, stmt.loc));
    const local = this.context.local(stmt.localId, stmt.loc);
    const helper = this.context.nextName("sc_async_protected_for_of");
    const array = this.context.nextName("sc_async_for_of_array");
    const index = this.context.nextName("sc_async_for_of_index");
    const arrayType = this.context.rustType(stmt.iterable.type, stmt.loc);
    const params = [
      `${result}: runtime::JsPromise<${this.context.rustType(fn.returnType, stmt.loc)}>`,
      `${array}: ${arrayType}`,
      `${index}: f64`,
      ...locals.map((candidate) =>
        `${mangleLocal(candidate.id)}: runtime::JsCell<${this.context.rustType(candidate.type, stmt.loc)}>`
      ),
    ];
    const call = (nextIndex: string) => `${helper}(${[
      `${result}.clone()`,
      `${array}.clone()`,
      nextIndex,
      ...locals.map((candidate) => `${mangleLocal(candidate.id)}.clone()`),
    ].join(", ")});`;

    this.context.line(`let ${array} = ${arrayValue ?? this.context.emitExpr(stmt.iterable)};`);
    this.context.line(`fn ${helper}(${params.join(", ")}) {`);
    this.context.pushIndent();
    this.withAsyncLocals(new Set(loopLocals), () => {
      this.context.line(`if ${index} < runtime::array_len(&${array}) {`);
      this.context.pushIndent();
      this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, stmt.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`);
      const iterationLocals = new Set(loopLocals);
      iterationLocals.add(local.id);
      this.withAsyncLocals(iterationLocals, () => {
        this.emitAsyncProtectedSequence(stmt.body, exitLocals, {
          fallthrough: () => this.withAsyncLocals(new Set(loopLocals), () => {
            this.context.line(call(`${index} + 1.0_f64`));
            this.context.line("return;");
          }),
          returned: handlers.returned,
          thrown: handlers.thrown,
        }, loc);
      });
      this.context.popIndent();
      this.context.line("} else {");
      this.context.pushIndent();
      this.withAsyncLocals(new Set(loopLocals), () => {
        this.emitAsyncProtectedSequence(remaining, exitLocals, handlers, loc);
      });
      this.context.popIndent();
      this.context.line("}");
    });
    this.context.popIndent();
    this.context.line("}");
    this.context.line(call("0.0_f64"));
  }

  emitAsyncProtectedConsole(
    expr: Extract<IrExpr, { kind: "intrinsic" }>,
    remaining: readonly IrStmt[],
    exitLocals: ReadonlySet<string>,
    handlers: RustAsyncHandlers,
    loc: SrcLoc,
    index = 0,
    values: { name: string; type: IrType; loc: SrcLoc }[] = [],
  ): void {
    const result = this.context.currentAsyncResult();
    if (result === null) this.context.unsupported("protected async console without a result promise", expr.loc);
    const arg = expr.args[index];
    if (arg === undefined) {
      const method = expr.name === "console.log" ? "console_log" : "console_error";
      this.context.line(`runtime::${method}(&[${values.map((value) =>
        this.context.displayValue(value.name, value.type, value.loc)).join(", ")}]);`);
      this.emitAsyncProtectedSequence(remaining, exitLocals, handlers, loc);
      return;
    }
    if (this.containsAsyncSuspension(arg)) {
      this.emitAsyncProtectedValue(
        arg,
        exitLocals,
        handlers,
        (value) => {
          this.emitAsyncProtectedConsole(expr, remaining, exitLocals, handlers, loc, index + 1, [
            ...values,
            { name: value, type: arg.type, loc: arg.loc },
          ]);
        },
      );
      return;
    }
    const value = this.context.nextName("sc_async_argument");
    this.context.line(`let ${value} = ${this.context.emitExpr(arg)};`);
    this.emitAsyncProtectedConsole(
      expr,
      remaining,
      exitLocals,
      handlers,
      loc,
      index + 1,
      [...values, { name: value, type: arg.type, loc: arg.loc }],
    );
  }

  emitAsyncCatch(
    stmt: Extract<IrStmt, { kind: "tryCatch" }>,
    remaining: readonly IrStmt[],
    outerLocals: ReadonlySet<string>,
    reason: string,
    onComplete: (() => void) | null,
  ): void {
    if (stmt.catchBody === null) {
      this.emitAsyncFinally(stmt, remaining, outerLocals, { kind: "throw", reason }, onComplete);
      return;
    }
    if (stmt.catchLocalId === null) {
      this.context.line(`let _ = ${reason};`);
    } else {
      const local = this.context.local(stmt.catchLocalId, stmt.loc);
      this.context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<runtime::Caught> = runtime::cell_new(${reason});`);
      this.context.currentAsyncLocals()?.add(local.id);
    }
    this.emitAsyncProtectedSequence(stmt.catchBody, outerLocals, {
      fallthrough: () => this.emitAsyncFinally(stmt, remaining, outerLocals, { kind: "fallthrough" }, onComplete),
      returned: (value) => this.emitAsyncFinally(stmt, remaining, outerLocals, { kind: "return", value }, onComplete),
      thrown: (catchReason) => this.emitAsyncFinally(stmt, remaining, outerLocals, { kind: "throw", reason: catchReason }, onComplete),
    }, stmt.loc);
  }

  emitAsyncFinally(
    stmt: Extract<IrStmt, { kind: "tryCatch" }>,
    remaining: readonly IrStmt[],
    outerLocals: ReadonlySet<string>,
    pending: RustAsyncCompletion,
    onComplete: (() => void) | null,
  ): void {
    if (stmt.finallyBody === null) {
      this.emitAsyncCompletion(remaining, pending, onComplete);
      return;
    }
    this.emitAsyncProtectedSequence(stmt.finallyBody, outerLocals, {
      fallthrough: () => this.emitAsyncCompletion(remaining, pending, onComplete),
      returned: (value) => this.emitAsyncCompletion(remaining, { kind: "return", value }, onComplete),
      thrown: (reason) => this.emitAsyncCompletion(remaining, { kind: "throw", reason }, onComplete),
    }, stmt.loc);
  }

  emitAsyncCompletion(
    remaining: readonly IrStmt[],
    completion: RustAsyncCompletion,
    onComplete: (() => void) | null,
  ): void {
    const result = this.context.currentAsyncResult();
    if (result === null) this.context.unsupported("async completion without a result promise", this.context.currentFunction()?.loc);
    if (completion.kind === "fallthrough") {
      this.emitAsyncStatements(remaining, onComplete);
    } else if (completion.kind === "return") {
      this.context.line(`let _ = runtime::promise_fulfill(&${result}, ${completion.value});`);
    } else {
      this.context.line(`let _ = runtime::promise_reject(&${result}, ${completion.reason});`);
    }
  }

  withAsyncLocals<T>(locals: Set<string>, emit: () => T): T {
    const previous = this.context.currentAsyncLocals();
    this.context.setCurrentAsyncLocals(locals);
    try {
      return emit();
    } finally {
      this.context.setCurrentAsyncLocals(previous);
    }
  }

  emitAsyncResumeHelper(
    statements: readonly IrStmt[],
    onComplete: (() => void) | null,
    liveLocals: ReadonlySet<string>,
    loc: SrcLoc,
    prefix: string,
  ): () => void {
    const result = this.context.currentAsyncResult();
    const fn = this.context.currentFunction();
    if (result === null || fn?.async !== true) {
      this.context.unsupported("async continuation helper outside an async function", loc);
    }
    const helper = this.context.nextName(`sc_async_${prefix}`);
    const locals = [...liveLocals].map((localId) => this.context.local(localId, loc));
    const params = [
      `${result}: runtime::JsPromise<${this.context.rustType(fn.returnType, loc)}>`,
      ...locals.map((local) =>
        `${mangleLocal(local.id)}: runtime::JsCell<${this.context.rustType(local.type, loc)}>`
      ),
    ];
    const call = `${helper}(${[
      `${result}.clone()`,
      ...locals.map((local) => `${mangleLocal(local.id)}.clone()`),
    ].join(", ")});`;
    this.context.line(`fn ${helper}(${params.join(", ")}) {`);
    this.context.pushIndent();
    this.withAsyncLocals(new Set(liveLocals), () => this.emitAsyncStatements(statements, onComplete));
    this.context.popIndent();
    this.context.line("}");
    return () => {
      this.context.line(call);
      this.context.line("return;");
    };
  }

}
