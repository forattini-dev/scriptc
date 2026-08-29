interface RustNativeMethodContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
}

/** Emit the closed set of prototype methods that can escape as dynamic functions. */
export function emitRustNativeMethodDefinition(context: RustNativeMethodContext): void {
  context.line("#[derive(Clone, Copy, PartialEq, Eq)]");
  context.line("enum ScDynNativeMethod {");
  context.pushIndent();
  context.line("NumberToString,");
  context.line("NumberToFixed,");
  context.popIndent();
  context.line("}");
  context.line("impl ScDynNativeMethod {");
  context.pushIndent();
  context.line("fn name(self) -> &'static str {");
  context.pushIndent();
  context.line("match self { Self::NumberToString => \"toString\", Self::NumberToFixed => \"toFixed\" }");
  context.popIndent();
  context.line("}");
  context.line("fn identity(self) -> usize { usize::MAX - self as usize }");
  context.popIndent();
  context.line("}");
}
