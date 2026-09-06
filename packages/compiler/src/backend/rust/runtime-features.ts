import type { IrModule } from "../../ir/nodes.js";
import { hasRustEmbeddedModules } from "./embedded-modules.js";

export type RustRuntimeFeature = "island-eval" | "island-v8" | "sqlite";

/** The island engine a build compiles in: boa (`island-eval`, the
 * default while the V8 lane comes up) or V8 (`island-v8`) under
 * SCRIPTC_ISLAND_ENGINE=v8. */
export function islandEngineFeature(): "island-eval" | "island-v8" {
  return process.env["SCRIPTC_ISLAND_ENGINE"] === "v8" ? "island-v8" : "island-eval";
}

/** Whether a feature list carries an island engine at all. */
export function featuresEmbedIsland(features: readonly RustRuntimeFeature[]): boolean {
  return features.includes("island-eval") || features.includes("island-v8");
}

/** Select heavyweight runtime facilities from the lowered IR, never source text. */
export function rustRuntimeFeatures(mod: IrModule): RustRuntimeFeature[] {
  let islandEval = hasRustEmbeddedModules(mod);
  const visit = (value: unknown): void => {
    if (islandEval || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown; op?: unknown };
    if (
      node.kind === "libCall" &&
      (node.fn === "island.eval" ||
        node.fn === "island.import" ||
        node.fn === "island.importDyn" ||
        node.fn === "island.importDynPath")
    ) {
      islandEval = true;
      return;
    }
    if (node.kind === "jsOp" && node.op === "globalGet") {
      islandEval = true;
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(mod);
  if (!islandEval) return [];
  // The SQLite kernel compiles (bundled amalgamation) only for graphs that
  // reach `bun:sqlite`; every other island build keeps the trap.
  const sqlite = mod.embedded?.bunRuntimeModules?.includes("bun:sqlite") === true;
  const engine = islandEngineFeature();
  return sqlite ? [engine, "sqlite"] : [engine];
}
