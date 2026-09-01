/* require() of a JSON document: the IDENTIFIER binding is the supported
 * form (the document bakes into a comptime global, like the ESM default
 * import of the same file). Two spellings keep their fence — destructuring
 * (a JSON namespace has no static story, like the named-import twin) and
 * the bare side-effect call, where Node PARSES the document and can throw.
 */
"use strict";
const pkg = require("./pkg.json");
const { version } = require("./pkg.json");
require("./pkg.json");

console.log(pkg.version);
console.log(version);
