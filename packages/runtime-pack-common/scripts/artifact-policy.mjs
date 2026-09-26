import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export async function assertArtifactsExcludeStrings(root, forbiddenStrings) {
  if (!Array.isArray(forbiddenStrings)) {
    throw new Error("runtime-pack forbidden artifact strings must be an array");
  }
  if (forbiddenStrings.length === 0) return;
  if (forbiddenStrings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("runtime-pack forbidden artifact strings must be non-empty strings");
  }
  const forbidden = forbiddenStrings.map((value) => ({ value, bytes: Buffer.from(value) }));
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(path);
      const match = forbidden.find((candidate) => bytes.includes(candidate.bytes));
      if (match !== undefined) {
        const artifact = relative(root, path).split(sep).join("/");
        throw new Error(
          `runtime-pack artifact ${artifact} contains forbidden symbol family ${match.value}`,
        );
      }
    }
  };
  await visit(root);
}
