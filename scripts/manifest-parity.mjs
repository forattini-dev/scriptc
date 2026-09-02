#!/usr/bin/env tsx
/* Reads the surface manifest's `backends` column and prints the Rust-vs-C
 * backend parity summary — the embryo of the backend-coverage dashboard.
 *
 * The project's mission is to replace the C and LLVM backends with the
 * Rust one, so the question this answers is "what does Rust still not
 * lower?" — per module, and at the libCall level underneath.
 *
 * Two tables, because they measure different things:
 *
 *  - SURFACE ENTRIES, per module: how many manifest entries with a
 *    DERIVED backend column each backend covers. Entries whose column is
 *    "unknown" (no libCall linkage to derive from) are counted apart and
 *    never folded into either side — an unknown is not a gap and not a
 *    win, and hiding it in a percentage would be the one lie this
 *    artifact exists to prevent.
 *  - libCALL SPELLINGS: the same question one level down, over the whole
 *    IrLibFn universe rather than the manifest's projection of it, so the
 *    surface table's "unknown" mass does not hide backend drift.
 *
 * Usage: pnpm manifest:parity  [--gaps]   (--gaps lists every entry and
 * spelling the C backend lowers and the Rust backend does not)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_LIB_CALLS } from "../packages/compiler/src/coverage/backend-libcalls.ts";
import { generateSurfaceManifest } from "../packages/compiler/src/coverage/surface-manifest.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8")).version;
const manifest = generateSurfaceManifest(version);
const showGaps = process.argv.includes("--gaps");

/** An entry's module: the id's first two dotted segments where the second
 * is a module or namespace ("node-builtin.fs", "stdlib.math"), the kind
 * alone otherwise. Matches how the manifest ids are shaped. */
function moduleOf(id) {
  const parts = id.split(".");
  return parts.length > 2 ? `${parts[0]}.${parts[1]}` : parts[0];
}

const modules = new Map();
const entryGaps = [];
for (const entry of manifest.entries) {
  const key = moduleOf(entry.id);
  let row = modules.get(key);
  if (row === undefined) {
    row = { module: key, c: 0, llvm: 0, rust: 0, derived: 0, unknown: 0 };
    modules.set(key, row);
  }
  if (entry.backends === "unknown") {
    row.unknown += 1;
    continue;
  }
  row.derived += 1;
  for (const backend of entry.backends) row[backend] += 1;
  if (entry.backends.includes("c") && !entry.backends.includes("rust")) entryGaps.push(entry.id);
}

const rows = [...modules.values()].sort((a, b) =>
  b.derived - a.derived || (a.module < b.module ? -1 : a.module > b.module ? 1 : 0),
);

const width = Math.max(6, ...rows.map((r) => r.module.length));
const pad = (text, size) => String(text).padStart(size);

const header = `${"module".padEnd(width)}  ${pad("rust", 5)} ${pad("c", 5)} ${pad("llvm", 5)}  ${pad("derived", 7)} ${pad("unknown", 7)}`;
console.log(`surface manifest ${manifest.compilerVersion} — backend coverage by module`);
console.log(header);
console.log("-".repeat(header.length));
for (const row of rows) {
  if (row.derived === 0 && row.unknown === 0) continue;
  console.log(
    `${row.module.padEnd(width)}  ${pad(row.rust, 5)} ${pad(row.c, 5)} ${pad(row.llvm, 5)}  ${pad(row.derived, 7)} ${pad(row.unknown, 7)}`,
  );
}

const totals = rows.reduce(
  (acc, row) => ({
    c: acc.c + row.c,
    llvm: acc.llvm + row.llvm,
    rust: acc.rust + row.rust,
    derived: acc.derived + row.derived,
    unknown: acc.unknown + row.unknown,
  }),
  { c: 0, llvm: 0, rust: 0, derived: 0, unknown: 0 },
);
console.log("-".repeat(header.length));
console.log(
  `${"TOTAL".padEnd(width)}  ${pad(totals.rust, 5)} ${pad(totals.c, 5)} ${pad(totals.llvm, 5)}  ${pad(totals.derived, 7)} ${pad(totals.unknown, 7)}`,
);
console.log(
  `rust covers ${totals.rust}/${totals.c} of the entries the C backend lowers` +
    ` (${((totals.rust / totals.c) * 100).toFixed(1)}%);` +
    ` ${totals.unknown} entries have no libCall linkage and are counted in neither side.`,
);

const spellings = Object.entries(BACKEND_LIB_CALLS);
const count = (backend) => spellings.filter(([, ids]) => ids.includes(backend)).length;
const spellingGaps = spellings
  .filter(([, ids]) => ids.includes("c") && !ids.includes("rust"))
  .map(([name]) => name);
console.log("");
console.log(
  `libCall spellings: ${spellings.length} total — c ${count("c")}, llvm ${count("llvm")}, rust ${count("rust")}` +
    ` (${spellingGaps.length} the C backend lowers and the Rust backend does not).`,
);

if (showGaps) {
  console.log("");
  console.log(`entries c lowers and rust does not (${entryGaps.length}):`);
  for (const id of entryGaps) console.log(`  ${id}`);
  console.log("");
  console.log(`libCall spellings c lowers and rust does not (${spellingGaps.length}):`);
  for (const name of spellingGaps) console.log(`  ${name}`);
}
