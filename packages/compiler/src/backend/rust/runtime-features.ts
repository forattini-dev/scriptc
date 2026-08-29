import type { IrModule } from "../../ir/nodes.js";
import { hasRustEmbeddedModules } from "./embedded-modules.js";

export type RustRuntimeFeature = "island-eval";

/** Select heavyweight runtime facilities from the lowered IR, never source text. */
export function rustRuntimeFeatures(mod: IrModule): RustRuntimeFeature[] {
  let islandEval = hasRustEmbeddedModules(mod);
  const visit = (value: unknown): void => {
    if (islandEval || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && node.fn === "island.eval") {
      islandEval = true;
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(mod);
  return islandEval ? ["island-eval"] : [];
}
