// @rust-only
// @no-engine
const bigIntsStringify = /([\[:])?"(-?\d+)n"($|\s*[,\}\]])/g;
const noiseStringify = /([\[:])?("-?\d+n+)n("$|"\s*[,\}\]])/g;
const converted = '{"value":"9007199254740993n","noise":"123nn"}';
const processed = converted.replace(bigIntsStringify, "$1$2$3");
const denoised = processed.replace(noiseStringify, "$1$2$3");
console.log("json-with-bigint shape", denoised);
const regex = /x/g;
const alias = regex;
console.log("alias", "xx".replace(alias, "$&!"), regex.lastIndex);
