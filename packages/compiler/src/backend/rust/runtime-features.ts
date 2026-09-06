import type { IrModule } from "../../ir/nodes.js";
import { hasRustEmbeddedModules } from "./embedded-modules.js";

export type RustRuntimeFeature = "island-eval" | "island-v8" | "sqlite";

/** The island engine a build compiles in: V8 (`island-v8`, the default —
 * the JIT is what puts an embedded npm graph at Bun's speed) or boa
 * (`island-eval`, pure Rust, no prebuilt archive) under
 * SCRIPTC_ISLAND_ENGINE=boa. The V8 crate's build script fetches its
 * prebuilt static library once and caches it under `~/.cargo/.rusty_v8`;
 * an offline host points RUSTY_V8_ARCHIVE at that file. */
export function islandEngineFeature(): "island-eval" | "island-v8" {
  return process.env["SCRIPTC_ISLAND_ENGINE"] === "boa" ? "island-eval" : "island-v8";
}

/** The island text store a build embeds with (CompileOptions.islandSourceStore):
 * raw on the V8 lane (the code cache makes the text a demand-paged
 * backstop, and the engine reads it in place), deflate on the boa lane. */
export function resolveIslandSourceStore(explicit: "raw" | "deflate" | undefined): "raw" | "deflate" {
  return explicit ?? (islandEngineFeature() === "island-v8" ? "raw" : "deflate");
}

/** Stamp the embedded graph with the store the build embeds with. */
export function withIslandStore(mod: IrModule, explicit: "raw" | "deflate" | undefined): IrModule {
  if (mod.embedded !== undefined) mod.embedded.store = resolveIslandSourceStore(explicit);
  return mod;
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
