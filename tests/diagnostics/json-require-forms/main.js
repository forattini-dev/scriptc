/* JSON require supports identifier bindings and flat object patterns.
 * Defaults retain an explicit refusal; bare calls keep their parse-failure
 * fence rather than silently lowering to nothing.
 */
"use strict";
const pkg = require("./pkg.json");
const { version = "unknown" } = require("./pkg.json");
require("./pkg.json");
console.log(pkg.version);
console.log(version);
