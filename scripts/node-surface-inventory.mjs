#!/usr/bin/env node
// Ingests Node's own API documentation database (all.json) for every runtime
// in the compat matrix and emits the DENOMINATOR: the module-qualified class
// list per version, plus the mechanical 24 → 26 diff.
//
// Why this exists: the compat profiles classify three slices (fetch, URL,
// EventEmitter) member by member, which answers "is this member supported?"
// but never "how much of Node is that?". Without a denominator the coverage
// story is a numerator with nothing under the line. all.json is Node's own
// generated inventory of its documented surface, so deriving the denominator
// from it is mechanical rather than a judgement call — and re-deriving it for
// a second major turns "Node 26 support" into a countable claim.
//
// This does NOT classify anything. Deciding what each class means for the
// compiler is profile work; this script only establishes what there is.
//
// The URLs move. nodejs.org/docs/v<exact version>/api/all.json is pinned by
// EXACT version (never /latest/, never a major alias), and both the byte
// length and the SHA-256 of what was fetched are recorded in the emitted
// artifact, so a silently changed upstream is detectable rather than assumed
// away. The raw downloads are ~8 MB each and are cached under
// node_modules/.cache/node-api/ rather than committed; pass --vendor-raw to
// write them into the inventory directory too if you want the bytes in-tree.
//
// Usage:
//   node scripts/node-surface-inventory.mjs           regenerate the artifacts
//   node scripts/node-surface-inventory.mjs --check   fail on drift, write nothing
//   node scripts/node-surface-inventory.mjs --offline use only the cache
//   node scripts/node-surface-inventory.mjs --vendor-raw   also vendor all.json
//
// Emits, under packages/compiler/compat/inventories/:
//   node-<version>-classes.json   the per-version denominator
//   node-class-diff.json          the mechanical delta between the two majors
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const inventoryDir = join(repoRoot, "packages/compiler/compat/inventories");
const cacheDir = join(repoRoot, "node_modules/.cache/node-api");

const flags = new Set(process.argv.slice(2));
const check = flags.has("--check");
const offline = flags.has("--offline");
const vendorRaw = flags.has("--vendor-raw");
for (const flag of flags) {
  if (!["--check", "--offline", "--vendor-raw"].includes(flag)) {
    console.error(`unknown flag '${flag}'`);
    process.exit(2);
  }
}

// The matrix, read as source text rather than imported: this script runs
// under a bare `node` with no loader, and duplicating two version strings is
// a worse trade than a build step. The parse is asserted, so a rename in
// node-matrix.ts fails loudly here instead of silently inventorying the
// wrong runtimes.
const matrixSource = readFileSync(
  join(repoRoot, "packages/compiler/src/compat/node-matrix.ts"),
  "utf8",
);
function matrixVersion(constant) {
  const match = new RegExp(`${constant}\\s*=\\s*"([^"]+)"`).exec(matrixSource);
  if (match === null) {
    throw new Error(
      `${constant} not found in compat/node-matrix.ts — the matrix moved and this script must follow it`,
    );
  }
  return match[1];
}
const versions = [matrixVersion("NODE24_VERSION"), matrixVersion("NODE26_VERSION")];

/**
 * Node's `name` for a class is prose, not an identifier: it may be bare
 * ("EventEmitter"), already module-qualified
 * ("events.EventEmitterAsyncResource"), or carry a superclause
 * ("BroadcastChannel extends EventTarget"). Normalizing to one bare
 * identifier is what makes the two versions comparable — without it the same
 * class appears as an add AND a remove whenever the docs gain or lose an
 * `extends` clause, which is a documentation edit rather than API surface.
 */
function bareClassName(name) {
  const withoutSuper = name.split(/\s+extends\s+/)[0].trim();
  return withoutSuper.includes(".")
    ? withoutSuper.slice(withoutSuper.lastIndexOf(".") + 1)
    : withoutSuper;
}

/** Node's doc database nests classes inside modules inside modules; the
 * `source` field ("doc/api/events.md") is the stable module qualifier. An
 * entry carries its own where it has one and inherits its parent's
 * otherwise, so a class is attributed to the document that defines it. */
function collectClasses(node, source, out) {
  const currentSource = typeof node.source === "string" ? node.source : source;
  for (const entry of node.classes ?? []) {
    const entrySource = typeof entry.source === "string" ? entry.source : currentSource;
    const owner = entrySource === undefined
      ? "(unattributed)"
      : entrySource.replace(/^doc\/api\//, "").replace(/\.md$/, "");
    out.add(`${owner}.${bareClassName(entry.name)}`);
    collectClasses(entry, entrySource, out);
  }
  for (const entry of node.modules ?? []) collectClasses(entry, currentSource, out);
  for (const entry of node.miscs ?? []) collectClasses(entry, currentSource, out);
}

async function loadAllJson(version) {
  const url = `https://nodejs.org/docs/v${version}/api/all.json`;
  const cached = join(cacheDir, `v${version}-all.json`);
  let bytes;
  if (existsSync(cached)) {
    bytes = readFileSync(cached);
  } else {
    if (offline) throw new Error(`--offline but ${cached} is not cached`);
    process.stderr.write(`fetching ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `${url} responded ${response.status} — the docs URL scheme may have moved; ` +
          `pin the new one here rather than falling back to a major alias`,
      );
    }
    bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, bytes);
  }
  return {
    url,
    bytes,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    document: JSON.parse(bytes.toString("utf8")),
  };
}

/** Byte-deterministic rendering: sorted keys, two-space indent, trailing
 * newline — so --check is a plain string comparison. */
const render = (value) => `${JSON.stringify(value, null, 2)}\n`;

const written = [];
function emit(name, value) {
  const path = join(inventoryDir, name);
  const rendered = render(value);
  if (check) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== rendered) {
      console.error(
        `${name} is stale — run 'node scripts/node-surface-inventory.mjs' and commit the result`,
      );
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(inventoryDir, { recursive: true });
  writeFileSync(path, rendered);
  written.push(name);
}

const inventories = new Map();
for (const version of versions) {
  const { url, bytes, digest, document } = await loadAllJson(version);
  const classes = new Set();
  collectClasses(document, undefined, classes);
  const sorted = [...classes].sort();
  const modules = [...new Set(sorted.map((name) => name.slice(0, name.lastIndexOf("."))))].sort();
  inventories.set(version, sorted);

  emit(`node-${version}-classes.json`, {
    schemaVersion: 1,
    node: version,
    source: {
      url,
      bytes: bytes.length,
      digest,
      note:
        "Pinned by EXACT version. The digest is what makes the pin verifiable: " +
        "a silently republished all.json changes it.",
    },
    counts: { modules: modules.length, classes: sorted.length },
    modules,
    classes: sorted,
  });

  if (vendorRaw) emit(`node-${version}-all.json`, document);
}

const [older, newer] = versions;
const before = new Set(inventories.get(older));
const after = new Set(inventories.get(newer));
const added = [...after].filter((name) => !before.has(name)).sort();
const removed = [...before].filter((name) => !after.has(name)).sort();

emit("node-class-diff.json", {
  schemaVersion: 1,
  from: older,
  to: newer,
  note:
    "The mechanical delta between the two matrix runtimes' documented class " +
    "surfaces, derived from Node's own all.json. It is a DENOMINATOR artifact: " +
    "nothing here is classified, and an added class is not a support claim in " +
    "either direction. A class that moved modules appears once in each list.",
  counts: {
    [older]: before.size,
    [newer]: after.size,
    added: added.length,
    removed: removed.length,
  },
  added,
  removed,
});

if (check) {
  if (process.exitCode === 1) process.exit(1);
  console.log("node surface inventories are up to date");
} else {
  console.log(`wrote ${written.join(", ")}`);
  console.log(
    `Node ${older}: ${before.size} classes; Node ${newer}: ${after.size} classes ` +
      `(+${added.length} / -${removed.length})`,
  );
}
