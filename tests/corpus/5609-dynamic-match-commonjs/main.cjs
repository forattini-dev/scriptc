// @ts-nocheck
const pattern = require("./pattern.cjs");
const match = "#!/usr/bin/env node".match(pattern);
console.log("commonjs", match && match[0], match && match[1]);
