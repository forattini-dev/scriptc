import type { IrFunction, IrStmt, SrcLoc } from "../../ir/nodes.js";
import { mangleLocal } from "../mangle.js";
import type { RustAsyncControlContext, RustAsyncHandlers } from "./async-control.js";

type ProtectedSequenceEmitter = (
  statements: readonly IrStmt[],
  exitLocals: ReadonlySet<string>,
  handlers: RustAsyncHandlers,
  loc: SrcLoc,
) => void;

type AsyncLocalsEmitter = <T>(locals: Set<string>, emit: () => T) => T;

function isUnlabeledBreak(statement: IrStmt): boolean {
  return statement.kind === "break" && statement.label === undefined;
}

/** Emit the canonical while-loop produced by `for await` inside try/catch. */
export function emitAsyncProtectedWhile(
  context: RustAsyncControlContext,
  emitSequence: ProtectedSequenceEmitter,
  withAsyncLocals: AsyncLocalsEmitter,
  stmt: Extract<IrStmt, { kind: "while" }>,
  remaining: readonly IrStmt[],
  exitLocals: ReadonlySet<string>,
  handlers: RustAsyncHandlers,
  loc: SrcLoc,
): void {
  const result = context.currentAsyncResult();
  const fn = context.currentFunction();
  if (result === null || fn?.async !== true) {
    context.unsupported("protected async while outside an async function", stmt.loc);
  }
  if ((stmt.labels?.length ?? 0) > 0 || stmt.cond.kind !== "boolLit" || !stmt.cond.value) {
    context.unsupported("non-canonical protected async while", stmt.loc);
  }
  const exitIndex = stmt.body.findIndex((candidate) =>
    candidate.kind === "if" && candidate.else_ === null && candidate.then.length === 1 &&
    candidate.then[0] !== undefined && isUnlabeledBreak(candidate.then[0])
  );
  const exit = stmt.body[exitIndex];
  if (exitIndex < 0 || exit?.kind !== "if") {
    context.unsupported("protected async while without a canonical exit", stmt.loc);
  }

  const head = stmt.body.slice(0, exitIndex);
  const tail = stmt.body.slice(exitIndex + 1);
  const loopLocals = new Set(context.currentAsyncLocals() ?? []);
  const headLocals = new Set(loopLocals);
  for (const statement of head) {
    if (statement.kind === "varDecl") headLocals.add(statement.localId);
  }
  const locals = [...loopLocals].map((localId) => context.local(localId, stmt.loc));
  const helper = context.nextName("sc_async_protected_while");
  const params = [
    `${result}: runtime::JsPromise<${context.rustType(fn.returnType, stmt.loc)}>`,
    ...locals.map((local: IrFunction["locals"][number]) =>
      `${mangleLocal(local.id)}: runtime::JsCell<${context.rustType(local.type, stmt.loc)}>`
    ),
  ];
  const call = `${helper}(${[
    `${result}.clone()`,
    ...locals.map((local: IrFunction["locals"][number]) => `${mangleLocal(local.id)}.clone()`),
  ].join(", ")});`;
  const nextIteration = () => withAsyncLocals(new Set(loopLocals), () => {
    context.line(call);
    context.line("return;");
  });

  context.line(`fn ${helper}(${params.join(", ")}) {`);
  context.pushIndent();
  withAsyncLocals(new Set(loopLocals), () => {
    emitSequence(head, headLocals, {
      fallthrough: () => {
        context.line(`if ${context.emitExpr(exit.cond)} {`);
        context.pushIndent();
        withAsyncLocals(new Set(loopLocals), () => emitSequence(remaining, exitLocals, handlers, loc));
        context.popIndent();
        context.line("} else {");
        context.pushIndent();
        withAsyncLocals(new Set(headLocals), () => emitSequence(tail, exitLocals, {
          fallthrough: nextIteration,
          returned: handlers.returned,
          thrown: handlers.thrown,
        }, loc));
        context.popIndent();
        context.line("}");
      },
      returned: handlers.returned,
      thrown: handlers.thrown,
    }, loc);
  });
  context.popIndent();
  context.line("}");
  context.line(call);
}
