import type { IrModule } from "../../ir/nodes.js";
import { hasRustEmbeddedModules } from "./embedded-modules.js";

export type RustRuntimeFeature = "island-eval" | "sqlite";

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
  return sqlite ? ["island-eval", "sqlite"] : ["island-eval"];
}
