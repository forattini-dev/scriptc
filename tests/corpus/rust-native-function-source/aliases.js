// @rust-only
// @no-engine
const parse = (JSON.parse);
const again = parse;
const stringify = JSON.stringify;
console.log("JS aliases", again.toString(), stringify.toString());
const cache = new Map();
cache.set(parse.toString(), true);
console.log("fingerprint", cache.has(JSON.parse.toString()), cache.has(JSON.stringify.toString()));
