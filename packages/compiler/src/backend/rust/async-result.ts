/** Continuation consumers receive an evaluated value, never deferred Rust
 * source whose effects would run after the next argument or outside its catch.
 * An existing temporary already satisfies that contract. */
export function emitAsyncResult(
  context: { nextName(prefix: string): string; line(value: string): void },
  expression: string,
  consume: (value: string) => void,
): void {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) {
    consume(expression);
    return;
  }
  const value = context.nextName("sc_async_evaluated");
  context.line(`let ${value} = ${expression};`);
  consume(value);
}

/** Protect only this expression. Its consumer may already be after the source
 * try block, so running that consumer inside the same catch would swallow an
 * unrelated later exception. Existing synchronous segments supply their own
 * catcher; resumed expressions need a fresh one. */
export function emitProtectedAsyncResult(
  context: { nextName(prefix: string): string; line(value: string): void; pushIndent(): void; popIndent(): void },
  expression: string,
  thrown: ((reason: string) => void) | null,
  consume: (value: string) => void,
): void {
  if (thrown === null || /^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) {
    emitAsyncResult(context, expression, consume);
    return;
  }
  const outcome = context.nextName("sc_async_expression");
  const value = context.nextName("sc_async_evaluated");
  context.line(`let ${outcome} = runtime::promise_try_segment(|| runtime::AsyncCompletion::Return(${expression}));`);
  context.line(`match ${outcome} {`);
  context.pushIndent();
  context.line(`Ok(runtime::AsyncCompletion::Return(${value})) => {`);
  context.pushIndent();
  consume(value);
  context.popIndent();
  context.line("}, Err(reason) => {");
  context.pushIndent();
  thrown("reason");
  context.popIndent();
  context.line('}, _ => unreachable!("scriptc invariant: expression returned no value"),');
  context.popIndent();
  context.line("}");
}
