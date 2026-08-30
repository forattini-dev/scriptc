import type { IrModule } from "../../ir/nodes.js";
import { dirname } from "node:path";

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
    let source = module.source;
    if (module.format === "cjs") {
      const hasRequireEdges = (mod.embedded?.edges ?? []).some(
        (edge) => edge.from === module.key && edge.kind !== "import",
      );
      if (hasRequireEdges) unsupported("embedded CommonJS require edges");
      const facadePrefix = `const m=globalThis.__scr_require(${JSON.stringify(module.key)});`;
      if (!module.esm?.startsWith(facadePrefix)) {
        unsupported("embedded CommonJS module without an ESM facade");
      }
      const facade = module.esm.slice(facadePrefix.length);
      source = [
        "const module={exports:{}};",
        "const require=(specifier)=>{const error=new Error(`Cannot find module '${specifier}'`);error.code='MODULE_NOT_FOUND';throw error;};",
        `const __filename=${JSON.stringify(module.key)};`,
        `const __dirname=${JSON.stringify(dirname(module.key))};`,
        "const __scr_cjs=function(exports,require,module,__filename,__dirname){",
        module.source,
        "};",
        "__scr_cjs.call(module.exports,module.exports,require,module,__filename,__dirname);",
        "const m=module.exports;",
        facade,
      ].join("\n");
    }
    const format = module.format === "json" ? "Json" : "Esm";
    lines.push(
      "    runtime::IslandModule { " +
        `key: "${rustString(module.key)}", ` +
        `source: "${rustString(source)}", ` +
        `format: runtime::IslandModuleFormat::${format} },`,
    );
  }
  lines.push("];", "");
  return lines;
}
