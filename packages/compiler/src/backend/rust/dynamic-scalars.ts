export interface RustDynamicScalarContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  dynTypeName(): string;
  hasEmbeddedModules(): boolean;
}

export function emitRustDynamicScalarChecks(context: RustDynamicScalarContext): void {
  const name = context.dynTypeName();
  for (const [expected, rustType, variant] of [
    ["number", "f64", "Number"],
    ["boolean", "bool", "Boolean"],
    ["string", "runtime::JsString", "String"],
  ] as const) {
    context.line(`fn sc_dyn_check_${expected}(value: ${name}) -> ${rustType} { sc_dyn_check_${expected}_at(value, "$" ) }`);
    context.line(`fn sc_dyn_check_${expected}_at(value: ${name}, path: &str) -> ${rustType} {`);
    context.pushIndent();
    // An island HANDLE holding the scalar exits strictly (a typed
    // callback's parameter arriving through the dyn bridge).
    const island = context.hasEmbeddedModules()
      ? `${name}::Island(handle) => runtime::island_exit_${expected}(&handle), `
      : "";
    context.line(`match value { ${name}::${variant}(value) => value, ${island}value => sc_dyn_check_fail_at("${expected}", &value, path) }`);
    context.popIndent();
    context.line("}");
  }
}
