import { statSync, lstatSync, type Stats } from "node:fs";
import { fileURLToPath } from "node:url";

function get(path: string, present: boolean): Stats | null {
  if (!present) return null;
  return statSync(path);
}
function describe(value: Stats | null): string {
  if (!value) return "missing";
  return value.isFile() && value.size > 0 ? "file" : "other";
}
function optional(path: string, present: boolean): Stats | undefined {
  if (!present) return undefined;
  return statSync(path);
}
const path = fileURLToPath(import.meta.url);
const snapshot = get(path, true);
const alias = snapshot;
console.log("present", describe(snapshot), snapshot === alias, snapshot === null);
if (snapshot) console.log("file-identity", snapshot.ino, snapshot.dev);
console.log("missing", describe(get(path, false)), get(path, false) === null);
console.log("optional", optional(path, false) === undefined, optional(path, true) !== undefined);

function regular(path: string): ReturnType<typeof lstatSync> | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
console.log("overload", regular(path) !== null, regular(path + ".missing-test") === null);
function earlierExit(path: string): string {
  const stat = regular(path);
  if (!stat) return "missing";
  return Number(stat.mtimeMs) > 0 ? "present" : "invalid";
}
console.log("prior-return", earlierExit(path), earlierExit(path + ".missing-test"));
for (const candidate of [path + ".missing-test", path]) {
  const stat = regular(candidate);
  if (!stat) continue;
  console.log("prior-continue", stat.isFile(), Number(stat.mtimeMs) > 0);
}
const current = regular(path);
if (current && Number(current.size) > 0) console.log("guarded", true);
if (current && current.isFile()) console.log("guarded-method", true);
const none = regular(path + ".missing-test");
console.log("optional-stats", (current?.size ?? 0) > 0, (current?.mtimeMs ?? 0) > 0, none?.size === undefined, none?.mtimeMs === undefined);
console.log("optional-identity", current?.ino === snapshot?.ino, current?.dev === snapshot?.dev, none?.ino === undefined, none?.dev === undefined);
if (none && Number(none.size) > 0) console.log("unexpected");
else console.log("guarded-empty", true);
let later!: Stats;
console.log("uninitialized", later === undefined);
later = statSync(path);
console.log("initialized", later.isFile());
