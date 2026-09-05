/// <reference path="./bun-sqlite.d.ts" />
import { Database } from "bun:sqlite";

// bun:sqlite exists only under the bun target: there its uses trap at
// runtime (the binary builds); under a Node target the import itself is
// the honest fence.
const db = new Database(":memory:");
console.log(typeof db);
