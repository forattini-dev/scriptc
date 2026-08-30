import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = 1_200;
// Readability is enforced per maintained source file. This is deliberately
// not an aggregate line budget for the compiler/runtime or generated Rust.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
  { directory: path.join(root, "packages", "compiler", "src", "backend", "rust"), extension: ".ts" },
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
  if (lines > MAX_LINES) violations.push({ file: path.relative(root, file), lines });
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}: ${violation.lines} lines (maximum ${MAX_LINES})`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Each maintained Rust-backend/runtime source file is at most ${MAX_LINES} lines; total source size is unrestricted.`,
  );
}
