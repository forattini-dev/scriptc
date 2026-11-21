// @ts-nocheck
// @rust-only
// @no-engine
import { mkdirSync, readdirSync } from "node:fs";

mkdirSync("entries");
mkdirSync("entries/b");
mkdirSync("entries/a");
const names = readdirSync("entries").sort();
console.log(names.join(","));
