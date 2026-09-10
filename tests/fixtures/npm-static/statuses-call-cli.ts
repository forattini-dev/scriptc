// The surface statuses-cli.ts documents but does not drive: `status(code)`
// itself. The package still compiles STATIC — the fences are runtime, on
// paths whose JSDoc contradicts the body (`@returns {number}` over a
// string-returning body). The internal message-map lookup now compiles and
// is exercised by statuses-message-cli.ts. npm-static.test.ts pins both
// the remaining restrictions and the supported path; this file is analyzed.
import status from "statuses";

console.log(status(404));
