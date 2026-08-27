export interface RustDynamicScalarContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  dynTypeName(): string;
}

export function emitRustDynamicScalarChecks(context: RustDynamicScalarContext): void {
  const name = context.dynTypeName();
  for (const [expected, rustType, variant] of [
    ["number", "f64", "Number"],
    ["boolean", "bool", "Boolean"],
    ["string", "runtime::JsString", "String"],
  ] as const) {
    context.line(`fn sc_dyn_check_${expected}(value: ${name}) -> ${rustType} {`);
    context.pushIndent();
    context.line(`match value { ${name}::${variant}(value) => value, value => sc_dyn_check_fail("${expected}", &value) }`);
    context.popIndent();
    context.line("}");
  }
}
