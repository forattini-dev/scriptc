import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = 1_200;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustSource = path.join(root, "packages", "runtime-rust", "src");

async function rustFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return rustFiles(target);
      return entry.isFile() && entry.name.endsWith(".rs") ? [target] : [];
    }),
  );
  return nested.flat();
}

const violations = [];
for (const file of await rustFiles(rustSource)) {
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
  console.log(`Rust source files respect the ${MAX_LINES}-line limit.`);
}
