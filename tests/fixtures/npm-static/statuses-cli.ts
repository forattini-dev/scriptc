// npm-static pilot: the real `statuses` package (vendored) — the
// EXPANDO-FUNCTION idiom in the wild. Its module body is
// `module.exports = status` with the data tables hung off the function
// (`status.message`, `status.empty`, `status.redirect`, `status.retry`,
// `status.codes`), the shape Express and its middleware reach for. Each
// member lowers as a module global keyed by (function symbol × member),
// so a member read through the DEFAULT IMPORT here routes to the same
// storage the package's own body writes.
//
// Two of the package's surfaces stay outside the driven set, both for
// reasons that have nothing to do with the expando lowering:
//   - `status(code)` — its JSDoc claims `@returns {number}` while the
//     body returns `getStatusMessage(code)`, a string (the ms precedent:
//     a JSDoc claim the body contradicts). Compiling it is a runtime
//     fence, pinned in npm-static.test.ts.
//   - `status.code[msg]` — `createMessageToStatusCodeMap` builds its map
//     as `var map = {}`, which inference types with no index signature,
//     so the string index is an implicit `any` the PROGRAM's typecheck
//     refuses. Reading it would drop the whole package to the island.
import status from "statuses";

console.log(status.message[404]);
console.log(status.message[200]);
console.log(status.message[500]);
console.log(status.empty[204] === true);
console.log(status.redirect[302] === true);
console.log(status.retry[503] === true);
console.log(status.codes.length);
console.log(status.codes[0]);
