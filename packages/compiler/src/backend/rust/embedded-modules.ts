import type { IrModule } from "../../ir/nodes.js";

export function hasRustEmbeddedModules(mod: IrModule): boolean {
  return (mod.embedded?.modules.length ?? 0) > 0;
}

/** Emit the immutable source table consumed by the Rust island module loader. */
export function emitRustEmbeddedModules(
  mod: IrModule,
  rustString: (value: string) => string,
  unsupported: (kind: string) => never,
): string[] {
  const modules = mod.embedded?.modules ?? [];
  if (!hasRustEmbeddedModules(mod)) return [];
  const lines = [
    `static SC_ISLAND_MODULES: [runtime::IslandModule; ${modules.length}] = [`,
  ];
  for (const module of modules) {
    if (module.format === "cjs") {
      unsupported("embedded CommonJS modules");
    }
    const format = module.format === "json" ? "Json" : "Esm";
    lines.push(
      "    runtime::IslandModule { " +
        `key: "${rustString(module.key)}", ` +
        `source: "${rustString(module.source)}", ` +
        `format: runtime::IslandModuleFormat::${format} },`,
    );
  }
  lines.push("];", "");
  return lines;
}
