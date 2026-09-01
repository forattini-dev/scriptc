import type { IrModule } from "../../ir/nodes.js";

export function hasRustEmbeddedModules(mod: IrModule): boolean {
  return (mod.embedded?.modules.length ?? 0) > 0;
}

/** Modules keep their SOURCE verbatim — CJS files are evaluated by the
 * island's require shim, and enter the ES graph through the `esm` facade
 * the compiler's CJS lexer synthesized at build time. */
const MODULE_FORMAT = { esm: "Esm", cjs: "Cjs", json: "Json" } as const;

/** Emit the immutable source and edge tables consumed by the Rust island
 * module loader and its require shim. */
export function emitRustEmbeddedModules(
  mod: IrModule,
  rustString: (value: string) => string,
): string[] {
  const modules = mod.embedded?.modules ?? [];
  if (!hasRustEmbeddedModules(mod)) return [];
  const lines = [
    `static SC_ISLAND_MODULES: [runtime::IslandModule; ${modules.length}] = [`,
  ];
  for (const module of modules) {
    lines.push(
      "    runtime::IslandModule { " +
        `key: "${rustString(module.key)}", ` +
        `source: "${rustString(module.source)}", ` +
        `format: runtime::IslandModuleFormat::${MODULE_FORMAT[module.format]}, ` +
        `esm: ${module.esm === undefined ? "None" : `Some("${rustString(module.esm)}")`} },`,
    );
  }
  lines.push("];", "");
  lines.push(...emitRustEmbeddedEdges(mod, rustString));
  return lines;
}

/** kind: the CALL FORM an edge resolved for — `Any` (relative files,
 * builtins) serves both lookups, while a dual package's "exports" map can
 * split one (from, specifier) into an `Import` and a `Require` edge. */
const EDGE_KIND = { any: "Any", import: "Import", require: "Require" } as const;

function emitRustEmbeddedEdges(
  mod: IrModule,
  rustString: (value: string) => string,
): string[] {
  const edges = mod.embedded?.edges ?? [];
  const lines = [
    `static SC_ISLAND_EDGES: [runtime::IslandEdge; ${edges.length}] = [`,
  ];
  for (const edge of edges) {
    lines.push(
      "    runtime::IslandEdge { " +
        `from: "${rustString(edge.from)}", ` +
        `specifier: "${rustString(edge.specifier)}", ` +
        `to: "${rustString(edge.to)}", ` +
        `kind: runtime::IslandEdgeKind::${EDGE_KIND[edge.kind]} },`,
    );
  }
  lines.push("];", "");
  return lines;
}
