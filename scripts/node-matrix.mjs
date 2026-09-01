#!/usr/bin/env tsx
// Runs the builtin-class conformance suites under every Node runtime the
// compat matrix declares — the local enforcement of the dual-target
// contract.
//
// Why a script rather than three package.json lines: `vitest run` inherits
// whatever `node` the shell happens to resolve, so "run the conformance
// suites" silently means "run them under one runtime, whichever one that
// is". The whole point of the matrix is that BOTH majors are first-class,
// and a gate that can only ever exercise one of them proves nothing about
// the other. This script names the interpreter explicitly, verifies the
// binary it found really is the version it claims to be, and runs the
// suites under each in turn.
//
// The runtime list is not duplicated here: it is read from
// packages/compiler/src/compat/node-matrix.ts, the same module the profiles
// and the suites read, so a runtime cannot be in the gate without being in
// the contract or vice versa. (Hence tsx: the matrix is TypeScript source,
// and the suites run against source too — no build step in between.)
//
// Usage:
//   pnpm gate:node-matrix              every declared runtime, in sequence
//   pnpm test:conformance:node24       one runtime by target id
//   pnpm test:conformance:node26
//
// Locating an interpreter, in order:
//   1. SCRIPTC_NODE_<TARGET ID>, e.g. SCRIPTC_NODE_NODE26=/path/to/node —
//      the escape hatch for a host that manages Node some other way;
//   2. the interpreter running this script, when its version matches;
//   3. the mise install tree ($MISE_DATA_DIR, else ~/.local/share/mise);
//   4. `mise which node@<version>`.
// Whatever is found is then asked for its --version and REJECTED if it
// disagrees, because a moved symlink otherwise turns the gate into a lie.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_COMPAT_MATRIX } from "../packages/compiler/src/compat/node-matrix.ts";
import { compatTargetList } from "../packages/compiler/src/compat/profile-schema.ts";
import {
  primaryOracleExecutable,
  resolveMatrixExecutable,
} from "../tests/harness/node-matrix.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The suites the matrix gate is FOR: the three profiles whose census is
 * runtime-reflected, so running them under a second major is the only way
 * to learn whether the second major agrees. */
const CONFORMANCE_SUITES = [
  "tests/harness/fetch-conformance.test.ts",
  "tests/harness/url-conformance.test.ts",
  "tests/harness/events-conformance.test.ts",
];

const targets = compatTargetList(NODE_COMPAT_MATRIX);

function usage(message) {
  console.error(message);
  console.error(
    `usage: node-matrix.mjs [--target <${targets.map((t) => t.id).join("|")}>] [-- <extra vitest args>]`,
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
let selected = null;
const passthrough = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--") {
    passthrough.push(...argv.slice(i + 1));
    break;
  }
  if (arg === "--target") {
    selected = argv[i + 1];
    i += 1;
    continue;
  }
  usage(`unexpected argument '${arg}'`);
}

const selectedTargets =
  selected === null ? targets : targets.filter((target) => target.id === selected);
if (selectedTargets.length === 0) {
  usage(`unknown target '${selected}'`);
}

// The semantic oracle is pinned to the primary and passed down explicitly,
// so the Node 26 lane reflects Node 26's SURFACE while still comparing
// compiled output against the one Node whose observable behavior the native
// runtime reproduces. Without this the lane reds on message rewording
// (Node 26 says "cannot" where Node 24 says "can not") and tells you
// nothing about the compiler. An oracle the caller already chose wins.
const oracle = primaryOracleExecutable(NODE_COMPAT_MATRIX);

const failures = [];
for (const target of selectedTargets) {
  const executable = resolveMatrixExecutable(target);
  console.log(
    `\n─── ${target.id}: Node ${target.node} — ${executable}\n` +
      `    semantic oracle: ${oracle}`,
  );
  try {
    execFileSync(
      executable,
      [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", ...CONFORMANCE_SUITES, ...passthrough],
      { cwd: repoRoot, stdio: "inherit", env: { ...process.env, SCRIPTC_NODE_ORACLE: oracle } },
    );
    console.log(`─── ${target.id}: PASS`);
  } catch {
    console.error(`─── ${target.id}: FAIL`);
    failures.push(target.id);
  }
}

if (failures.length > 0) {
  console.error(
    `\nnode matrix gate FAILED under: ${failures.join(", ")} ` +
      `(of ${selectedTargets.length} runtime(s))`,
  );
  process.exit(1);
}
console.log(
  `\nnode matrix gate PASSED under ${selectedTargets.length} runtime(s): ` +
    `${selectedTargets.map((target) => `Node ${target.node}`).join(", ")}`,
);
