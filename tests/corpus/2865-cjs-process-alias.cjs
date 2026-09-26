// The CommonJS process module is the global process object. Its identifier
// binding keeps the static process surface across TS 7's alias wrappers.
// @ts-ignore the root corpus intentionally runs without @types/node
const processAlias = require("node:process");

console.log(processAlias.platform === process.platform);
console.log(processAlias.argv.slice(2).join(","));
console.log(processAlias.versions.node === process.versions.node);
