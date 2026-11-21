// @rust-only
// @no-engine
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const root = "readdir-dirent-owned";
rmSync(root, { recursive: true, force: true });
mkdirSync(`${root}/nested`, { recursive: true });
writeFileSync(`${root}/file.txt`, "content");
let files = 0;
let directories = 0;
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.name === "file.txt" && entry.isFile()) files += 1;
  if (entry.name === "nested" && entry.isDirectory()) directories += 1;
  console.log(entry.name.length > 0, entry.isSymbolicLink());
}
console.log(files, directories);
rmSync(root, { recursive: true, force: true });
