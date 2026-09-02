#!/usr/bin/env tsx
/* Generates packages/compiler/src/coverage/backend-libcalls.ts — the
 * per-backend libCall recognition sets the surface manifest's `backends`
 * column is projected from.
 *
 * WHY A GENERATED TABLE AND NOT A RUNTIME SCAN: the manifest generator
 * ships inside @scriptc/compiler and is imported from its BUILT dist by
 * consumers and by tests, where the backend TypeScript sources are not
 * on disk. So the derivation runs here, at authoring time, and lands as
 * a checked-in module; `--check` (wired into `pnpm lint`, exactly like
 * gen-island-bootstrap.mjs) fails when the committed table drifts from
 * the sources.
 *
 * THE DERIVATION. The universe of libCall spellings is LIB_FN_SIGS —
 * `Record<IrLibFn, ...>`, so every spelling the IR can carry appears
 * exactly once. Each backend recognizes a spelling by naming it in its
 * own emitter sources; a spelling no source names reaches that backend's
 * generic refusal (the Rust backend's `context.unsupported("library call
 * '<fn>'")` tail, the LLVM backend's unsupported.ts). So for each backend
 * root, a spelling is RECOGNIZED iff either:
 *
 *   (1) it appears verbatim as a string literal in a non-test source
 *       under the root — the `case "fs.readFileSync":` / `expr.fn ===
 *       "fs.readFileSync"` / name-map-key form all three backends use; or
 *   (2) the file dispatches on the spelling's NAMESPACE prefix
 *       (`startsWith("url.")`) and names the member tail as its own
 *       literal — the one other dispatch idiom in the tree (the Rust
 *       backend's URL component getters), which rule (1) alone would
 *       under-report.
 *
 * Rule (2) is not a heuristic reaching for extra hits: over the current
 * tree it adds exactly the eleven Rust `url.*` component getters and
 * nothing else. Both rules are syntactic, so the table is a claim about
 * what each emitter NAMES, never about which argument shapes it accepts —
 * the manifest's coverage notes say so, and the arity/shape fences the
 * emitters raise per site stay outside this projection.
 *
 * Usage:
 *   pnpm gen:backend-libcalls           regenerate the module
 *   pnpm gen:backend-libcalls --check   fail (exit 1) instead of writing
 *                                       when the committed module is stale
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIB_FN_SIGS } from "../packages/compiler/src/ir/validate.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "packages/compiler/src/coverage/backend-libcalls.ts");

/** The emitter source root of each backend — where that backend decides,
 * for one libCall spelling, whether it has a lowering at all. */
const BACKEND_ROOTS = {
  c: "packages/compiler/src/backend/emission",
  llvm: "packages/compiler/src/backend/llvm",
  rust: "packages/compiler/src/backend/rust",
};

/** Non-test TypeScript sources under one root, in a stable order. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// Single-line string literals of any quote style, escape-free (a libCall
// spelling is `namespace.member` — no escapes, no interpolation).
const LITERAL = /["'`]([^"'`\n\\]{1,120})["'`]/g;
// The namespace-prefix dispatch idiom: `expr.fn.startsWith("url.")`.
const PREFIX_DISPATCH = /startsWith\(\s*["'`]([A-Za-z][A-Za-z0-9]*\.)["'`]/g;

/** The subset of `names` the sources under `dir` name, per the two rules. */
function recognized(dir, names) {
  const found = new Set();
  for (const file of sources(dir)) {
    const text = readFileSync(file, "utf8");
    const literals = new Set();
    for (const m of text.matchAll(LITERAL)) literals.add(m[1]);
    const prefixes = new Set();
    for (const m of text.matchAll(PREFIX_DISPATCH)) prefixes.add(m[1]);
    for (const name of names) {
      if (found.has(name)) continue;
      if (literals.has(name)) {
        found.add(name);
        continue;
      }
      const dot = name.indexOf(".");
      if (dot > 0 && prefixes.has(name.slice(0, dot + 1)) && literals.has(name.slice(dot + 1))) {
        found.add(name);
      }
    }
  }
  return found;
}

const names = Object.keys(LIB_FN_SIGS).sort();
const perBackend = Object.fromEntries(
  Object.entries(BACKEND_ROOTS).map(([id, dir]) => [id, recognized(path.join(root, dir), names)]),
);

// A spelling no backend names would mean the IR can carry a call nothing
// lowers — an inconsistency in the tree, not a row to publish.
const orphans = names.filter((name) => !Object.values(perBackend).some((set) => set.has(name)));
if (orphans.length > 0) {
  console.error(`libCall spellings no backend names: ${orphans.join(", ")}`);
  process.exit(1);
}

const rows = names
  .map((name) => {
    const ids = Object.keys(BACKEND_ROOTS).filter((id) => perBackend[id].has(name));
    return `  ${JSON.stringify(name)}: [${ids.map((id) => `"${id}"`).join(", ")}],`;
  })
  .join("\n");

const rootList = Object.entries(BACKEND_ROOTS)
  .map(([id, dir]) => ` *   ${id.padEnd(4)} ${dir}`)
  .join("\n");

const rendered = `/* GENERATED FILE — do not edit by hand.
 * Regenerate with \`pnpm gen:backend-libcalls\`; \`pnpm lint\` fails while
 * this file is stale. The derivation, its two rules, and why it lives as
 * a generated module are documented in scripts/gen-backend-libcalls.mjs.
 *
 * Each row names the backends whose emitter sources NAME that libCall
 * spelling — a lowering exists there. Emitter roots:
 *
${rootList}
 *
 * A backend missing from a row refuses that spelling generically (the
 * Rust backend's "library call '<fn>'" tail, the LLVM backend's
 * unsupported.ts). Presence is not a claim about argument shapes: the
 * per-site arity and shape fences live in the emitters and are outside
 * this table. */

/** The compiler's code-generating backends, in the manifest's fixed
 * column order. */
export const BACKEND_IDS = ["c", "llvm", "rust"] as const;

export type BackendId = (typeof BACKEND_IDS)[number];

/** libCall spelling → the backends that lower it. Keys are exactly the
 * IrLibFn union (LIB_FN_SIGS), sorted; no row is ever empty. */
export const BACKEND_LIB_CALLS: Readonly<Record<string, readonly BackendId[]>> = {
${rows}
};
`;

const current = (() => {
  try {
    return readFileSync(outPath, "utf8");
  } catch {
    return null;
  }
})();

if (process.argv.includes("--check")) {
  if (current !== rendered) {
    console.error(
      "packages/compiler/src/coverage/backend-libcalls.ts is stale — run 'pnpm gen:backend-libcalls' and commit the result",
    );
    process.exit(1);
  }
  console.log(`backend-libcalls.ts is current (${names.length} libCall spellings)`);
} else {
  if (current !== rendered) writeFileSync(outPath, rendered);
  const counts = Object.keys(BACKEND_ROOTS)
    .map((id) => `${id}=${perBackend[id].size}`)
    .join(" ");
  console.log(`wrote backend-libcalls.ts — ${names.length} spellings (${counts})`);
}
