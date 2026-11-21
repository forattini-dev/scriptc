// @rust-only
// @no-engine
import * as fs from "node:fs";
import { statSync as stat, lstatSync, type Stats as FileStats } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const filename = fileURLToPath(import.meta.url);
const snapshot = stat(filename);
const alias = snapshot;
console.log("file", snapshot.isFile(), snapshot.isDirectory(), snapshot.isSymbolicLink(), snapshot.size > 0);
console.log("alias", snapshot.size === alias.size);
const repeated = fs.statSync(filename);
console.log("metadata", snapshot.uid === repeated.uid, snapshot.gid === repeated.gid, snapshot.blocks === repeated.blocks, snapshot.nlink === repeated.nlink, snapshot.atimeMs === repeated.atimeMs);
console.log("direct", fs.statSync(filename).size === snapshot.size);
const directory = lstatSync(dirname(filename));
console.log("directory", directory.isDirectory(), directory.isFile(), directory.isSymbolicLink());
function read(value: FileStats): number { return value.size; }
function snapshotOf(path: string): FileStats { return stat(path); }
console.log("typed", read(snapshot) === snapshotOf(filename).size);
const holder: { value: FileStats } = { value: snapshot };
console.log("record", holder.value.size === alias.size);
const readCallback: (value: FileStats) => number = (value) => value.size;
const readAlias = read;
console.log("callbacks", readCallback(snapshot) === readAlias(alias));
const size = (): number => snapshot.size;
console.log("capture", size() === snapshot.size);
let trace = "";
function path(): string { trace = trace + "path,"; return filename; }
function get(): FileStats { trace = trace + "receiver,"; return stat(path()); }
console.log("order", get().isFile(), trace);
function optional(value: FileStats | null): boolean | undefined { return value?.isFile(); }
console.log("optional", optional(snapshot), optional(null) === undefined);
// Source names alone cannot select the native Stats ABI.
class Stats {
  size: number = 13;
  isFile(): boolean { return false; }
}
const own = new Stats();
console.log("shadow", own.size, own.isFile());
