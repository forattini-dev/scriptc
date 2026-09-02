import { deflateRawSync } from "node:zlib";
import { NPM_COMPRESS_MIN, type IrModule } from "../../ir/nodes.js";

export function hasRustEmbeddedModules(mod: IrModule): boolean {
  return (mod.embedded?.modules.length ?? 0) > 0;
}

/** Modules keep their SOURCE verbatim — CJS files are evaluated by the
 * island's require shim, and enter the ES graph through the `esm` facade
 * the compiler's CJS lexer synthesized at build time. */
const MODULE_FORMAT = { esm: "Esm", cjs: "Cjs", json: "Json" } as const;

/** One module text as it is STORED in the binary, mirroring the C lane's
 * rule exactly (emit-island.ts): text at least NPM_COMPRESS_MIN long
 * stores as raw DEFLATE when that actually shrinks it, and the row
 * carries the inflated length beside the stored bytes so the runtime can
 * size its output buffer in one shot. `raw: 0` means "the bytes ARE the
 * text" — the sentinel both lanes share.
 *
 * Why this matters here: a --dynamic build embeds every reached npm
 * source, which for a real CLI graph is tens of megabytes of JavaScript —
 * THE dominant binary-size term. The C lane has compressed since it
 * gained npm embedding; the Rust lane shipped the text raw, so its
 * binaries ran 3-4x larger for the same program. */
function storedText(text: string): { bytes: Buffer; raw: number } {
  const plain = Buffer.from(text, "utf8");
  if (text.length < NPM_COMPRESS_MIN) return { bytes: plain, raw: 0 };
  const deflated = deflateRawSync(plain, { level: 9 });
  return deflated.length < plain.length
    ? { bytes: deflated, raw: plain.length }
    : { bytes: plain, raw: 0 };
}

/** Render bytes as a Rust BYTE-string literal (`b"..."`).
 *
 * A byte string, not a `&str`: DEFLATE output is arbitrary bytes and is
 * not UTF-8, so the stored form cannot be a string literal at all. Only
 * the three characters Rust's own lexer needs escaped, plus everything
 * outside printable ASCII, take a `\xNN` — so the plain-stored (small)
 * modules read as their own source in the emitted crate, and the
 * compressed ones cost ~2.9 characters per byte, which against a 3-4x
 * smaller payload leaves the emitted .rs about where it was while the
 * linked binary shrinks by the full compression ratio. */
function rustByteString(bytes: Buffer): string {
  let out = 'b"';
  for (const byte of bytes) {
    if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x22) out += '\\"';
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out + '"';
}

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
    const source = storedText(module.source);
    const esm = module.esm !== undefined ? storedText(module.esm) : undefined;
    lines.push(
      "    runtime::IslandModule { " +
        `key: "${rustString(module.key)}", ` +
        `source: ${rustByteString(source.bytes)}, ` +
        `source_raw: ${source.raw}, ` +
        `format: runtime::IslandModuleFormat::${MODULE_FORMAT[module.format]}, ` +
        `esm: ${esm === undefined ? "None" : `Some(${rustByteString(esm.bytes)})`}, ` +
        `esm_raw: ${esm?.raw ?? 0} },`,
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
