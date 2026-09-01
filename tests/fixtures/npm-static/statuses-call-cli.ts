// The surface statuses-cli.ts documents but does not drive: `status(code)`
// itself. The package still compiles STATIC — the fences are runtime, on
// paths whose JSDoc contradicts the body (`@returns {number}` over a
// string-returning body) and on `createMessageToStatusCodeMap`'s
// index-signature-less `var map = {}`. npm-static.test.ts pins them; this
// file is never executed, only analyzed.
import status from "statuses";

console.log(status(404));
