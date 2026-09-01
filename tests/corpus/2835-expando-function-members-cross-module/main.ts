// Expando function members read ACROSS a module boundary: the importer's
// `status.message[404]` must reach the exporter's member storage, and the
// CALL `status(404)` stays an ordinary function call. Routing is by
// SYMBOL identity, so an import alias and the exporter's own name reach
// the same slots, while a second module's identically-spelled members
// (named.ts) keep their own.
import status from "./status.ts";
import { named } from "./named.ts";

console.log(status.message[404]);
console.log(status.message[200]);
console.log(status(404), status(200));
console.log(status.label);
console.log(status.empty[204], status.empty[205]);
console.log(status.codes.length, status.codes[0], status.codes[4]);
console.log(status.describe(500));

// Members are live storage, not snapshots: a write through the importer's
// alias is visible to the exporter's own body.
status.message[418] = "I'm a Teapot";
console.log(status(418));

// A second module's expando function keeps its own slots.
console.log(named.tag, named(3));
console.log(JSON.stringify(status.empty), JSON.stringify(named.pairs));
