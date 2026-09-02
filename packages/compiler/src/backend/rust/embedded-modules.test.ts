/* The Rust lane's embedded npm tables, at the level the C lane's storage
 * rule lives: a `--dynamic` build embeds every reached module SOURCE, so
 * these rows are the dominant term in the binary's size, and texts at or
 * above NPM_COMPRESS_MIN are stored as raw DEFLATE with their inflated
 * length beside them. The runtime half (inflate on first use, cached) is
 * pinned in packages/runtime-rust/src/tests/island_modules.rs; the
 * end-to-end behavior in packages/compiler/test/emit-rust-island-modules
 * .test.ts. */
import { inflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { NPM_COMPRESS_MIN, type IrModule } from "../../ir/nodes.js";
import { emitRustEmbeddedModules } from "./embedded-modules.js";

type EmbeddedModule = NonNullable<IrModule["embedded"]>["modules"][number];

/** The emitter reads only `embedded`, so the rest of the IrModule is not
 * constructed — the cast is the test's whole knowledge of that coupling. */
function emit(modules: EmbeddedModule[]): string {
  const mod = { embedded: { modules, edges: [] } } as unknown as IrModule;
  // The real rustString escapes for a Rust string literal; module keys in
  // these fixtures need no escaping, so identity keeps the fixtures legible.
  return emitRustEmbeddedModules(mod, (value) => value).join("\n");
}

/** Recover one emitted `b"..."` byte-string literal back to bytes. */
function decodeByteString(literal: string): Buffer {
  const body = literal.slice(2, -1);
  const bytes: number[] = [];
  for (let at = 0; at < body.length; ) {
    if (body[at] !== "\\") {
      bytes.push(body.charCodeAt(at));
      at += 1;
    } else if (body[at + 1] === "x") {
      bytes.push(parseInt(body.slice(at + 2, at + 4), 16));
      at += 4;
    } else {
      bytes.push(body.charCodeAt(at + 1));
      at += 2;
    }
  }
  return Buffer.from(bytes);
}

function sourceLiteralOf(emitted: string): string {
  const match = /source: (b"(?:[^"\\]|\\.)*")/.exec(emitted);
  expect(match, "the emitted row must carry a source byte-string").not.toBeNull();
  return match![1]!;
}

describe("Rust embedded npm module storage", () => {
  test("a short module is stored verbatim, with raw = 0", () => {
    const source = "export const value = 1;\n";
    expect(source.length).toBeLessThan(NPM_COMPRESS_MIN);
    const emitted = emit([{ key: "/pkg/small.mjs", source, format: "esm" }]);

    expect(emitted).toContain("source_raw: 0");
    expect(emitted).toContain("esm_raw: 0");
    // Verbatim means readable: a small module's text is still its own
    // bytes in the emitted crate.
    expect(decodeByteString(sourceLiteralOf(emitted)).toString("utf8")).toBe(source);
  });

  test("a module at NPM_COMPRESS_MIN is stored as raw DEFLATE with its inflated length", () => {
    const source = "export const parts = [\n" + '  "a repeated payload line",\n'.repeat(200) + "];\n";
    expect(source.length).toBeGreaterThanOrEqual(NPM_COMPRESS_MIN);
    const emitted = emit([{ key: "/pkg/big.mjs", source, format: "esm" }]);

    expect(emitted).toContain(`source_raw: ${source.length}`);
    const stored = decodeByteString(sourceLiteralOf(emitted));
    expect(stored.length, "compressible text must actually shrink").toBeLessThan(source.length);
    // The stream is what the runtime's flate2 inflater reads: raw DEFLATE,
    // no zlib wrapper — the same format the C lane stores.
    expect(inflateRawSync(stored).toString("utf8")).toBe(source);
  });

  test("incompressible text at the threshold falls back to verbatim storage", () => {
    // The rule is "compress when it SHRINKS", not "compress when long":
    // storing a grown stream would cost size and an inflate for nothing.
    let source = "";
    for (let at = 0; at < NPM_COMPRESS_MIN + 64; at += 1) {
      source += String.fromCharCode(0x20 + ((at * 7919) % 95));
    }
    const emitted = emit([{ key: "/pkg/noise.mjs", source, format: "esm" }]);

    const stored = decodeByteString(sourceLiteralOf(emitted));
    if (emitted.includes("source_raw: 0")) {
      expect(stored.toString("utf8")).toBe(source);
    } else {
      expect(stored.length).toBeLessThan(Buffer.byteLength(source, "utf8"));
    }
  });

  test("a CJS module's ESM facade is stored and sized on its own", () => {
    // Source and facade are independent texts: a long source beside a
    // short facade must compress exactly one of them.
    const source = "module.exports = {\n" + '  key: "value",\n'.repeat(200) + "};\n";
    const esm = 'const m = globalThis.__scr_require("/pkg/dual.js");\nexport default m;\n';
    expect(esm.length).toBeLessThan(NPM_COMPRESS_MIN);
    const emitted = emit([{ key: "/pkg/dual.js", source, format: "cjs", esm }]);

    expect(emitted).toContain(`source_raw: ${source.length}`);
    expect(emitted).toContain("esm_raw: 0");
    expect(emitted).toContain("format: runtime::IslandModuleFormat::Cjs");
  });

  test("the emitted byte strings escape exactly what Rust's lexer needs", () => {
    // Quotes and backslashes must survive the crossing, and a byte outside
    // printable ASCII must not land raw in the emitted source.
    const source = 'const s = "a\\\\b";\nÿ\n';
    const emitted = emit([{ key: "/pkg/escapes.mjs", source, format: "esm" }]);

    const literal = sourceLiteralOf(emitted);
    expect(literal).not.toMatch(/[^\x20-\x7e]/);
    expect(decodeByteString(literal).toString("utf8")).toBe(source);
  });

  test("no module table is emitted when nothing is embedded", () => {
    expect(emit([])).toBe("");
  });
});
