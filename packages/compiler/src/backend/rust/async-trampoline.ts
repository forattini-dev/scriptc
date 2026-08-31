export interface RustAsyncTrampolineContext {
  nextName(prefix: string): string;
}

export function asyncTrampolineCall(
  context: RustAsyncTrampolineContext,
  helper: string,
  args: readonly string[],
): string {
  const captures = args.map((arg) => ({ arg, name: context.nextName("sc_async_next") }));
  const bindings = captures.map(({ arg, name }) => `let ${name} = ${arg};`).join(" ");
  return `{ ${bindings} runtime::async_trampoline(${helper} as usize, Box::new(move || ${helper}(${captures.map(({ name }) => name).join(", ")}))); }`;
}
