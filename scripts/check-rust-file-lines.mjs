import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = 1_200;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// These predate the repository-wide rule. Their exact size is frozen so
// they cannot grow unnoticed; every extraction lowers the recorded ceiling
// until the entry disappears at 1,200 lines. This is debt tracking, not an
// exemption from the final rule.
const legacyOversizedFiles = new Map([
  ["packages/compiler/src/backend/cc.test.ts", 4_104],
  ["packages/compiler/src/backend/cc.ts", 6_087],
  ["packages/compiler/src/backend/emission/emit-async.ts", 1_279],
  ["packages/compiler/src/backend/emission/emit-exprs.ts", 7_965],
  ["packages/compiler/src/backend/emission/emit-walkers.ts", 2_062],
  ["packages/compiler/src/backend/emission/emitter.ts", 2_134],
  ["packages/compiler/src/backend/llvm/dyn.ts", 3_105],
  ["packages/compiler/src/backend/llvm/emitter.ts", 14_427],
  ["packages/compiler/src/frontend/lowering/lower-assert.ts", 1_492],
  ["packages/compiler/src/frontend/lowering/lower-builtins.ts", 8_251],
  ["packages/compiler/src/frontend/lowering/lower-calls.ts", 9_598],
  ["packages/compiler/src/frontend/lowering/lower-classes.ts", 5_942],
  ["packages/compiler/src/frontend/lowering/lower-containers.ts", 8_061],
  ["packages/compiler/src/frontend/lowering/lower-emitter.ts", 1_325],
  ["packages/compiler/src/frontend/lowering/lower-exprs.ts", 11_170],
  ["packages/compiler/src/frontend/lowering/lower-inspect.ts", 1_471],
  ["packages/compiler/src/frontend/lowering/lower-island.ts", 3_407],
  ["packages/compiler/src/frontend/lowering/lower-modules.ts", 2_109],
  ["packages/compiler/src/frontend/lowering/lower-server.ts", 4_812],
  ["packages/compiler/src/frontend/lowering/lower-stmts.ts", 8_017],
  ["packages/compiler/src/frontend/lowering/lower-stream.ts", 1_912],
  ["packages/compiler/src/frontend/lowering/lowerer.ts", 9_401],
  ["packages/compiler/src/frontend/lowering/surfaces.ts", 1_771],
  ["packages/compiler/src/frontend/npm.ts", 1_820],
  ["packages/compiler/src/frontend/program.ts", 3_016],
  ["packages/compiler/src/frontend/types.ts", 4_008],
  ["packages/compiler/src/index.ts", 2_559],
  ["packages/compiler/src/ir/nodes.ts", 7_560],
  ["packages/compiler/src/ir/validate.ts", 5_731],
  ["packages/compiler/src/library/int-infer.ts", 1_748],
  ["packages/compiler/src/library/sidecar.ts", 1_649],
]);

// Readability is enforced per maintained source file. Total project size is
// deliberately unrestricted; generated artifacts and the C/LLVM runtimes
// are outside these source roots.
const sourceRoots = [
  { directory: path.join(root, "packages", "compiler", "src"), extension: ".ts" },
  { directory: path.join(root, "packages", "cli", "src"), extension: ".ts" },
  { directory: path.join(root, "packages", "runtime-rust", "src"), extension: ".rs" },
];

async function sourceFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(target, extension);
      return entry.isFile() && entry.name.endsWith(extension) ? [target] : [];
    }),
  );
  return nested.flat();
}

const violations = [];
const files = (await Promise.all(
  sourceRoots.map(({ directory, extension }) => sourceFiles(directory, extension)),
)).flat();
for (const file of files) {
  const source = await readFile(file, "utf8");
  const lines = source.length === 0 ? 0 : source.split("\n").length - Number(source.endsWith("\n"));
  const relative = path.relative(root, file);
  const legacyCeiling = legacyOversizedFiles.get(relative);
  if (lines <= MAX_LINES) {
    if (legacyCeiling !== undefined) {
      violations.push({
        file: relative,
        message: `${lines} lines now fits the limit; remove its stale debt entry`,
      });
    }
    continue;
  }
  if (legacyCeiling === undefined) {
    violations.push({ file: relative, message: `${lines} lines (maximum ${MAX_LINES})` });
  } else if (lines !== legacyCeiling) {
    violations.push({
      file: relative,
      message: `${lines} lines (frozen debt ceiling ${legacyCeiling}; update it only after a reviewed reduction)`,
    });
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}: ${violation.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Maintained compiler/Rust files respect the ${MAX_LINES}-line limit or an exact frozen debt ceiling; total source size is unrestricted.`,
  );
}
