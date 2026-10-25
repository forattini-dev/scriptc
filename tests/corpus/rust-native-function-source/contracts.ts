// @rust-only
// @no-engine
console.log("sources", JSON.parse.toString(), JSON.stringify.toString(), String.toString());
const parse = JSON.parse;
const alias = parse;
const stringify = JSON.stringify;
const text = String;
console.log("aliases", alias.toString() === JSON.parse.toString(), stringify.toString(), text.toString());
console.log("identity", alias === JSON.parse, parse === alias);
const fingerprints = new Map<string, boolean>();
fingerprints.set(JSON.parse.toString(), true);
console.log("cache", fingerprints.has(alias.toString()), fingerprints.get(alias.toString()) === true, fingerprints.has(stringify.toString()));
console.log("type assertions", (alias as typeof JSON.parse).toString(), (String satisfies StringConstructor).toString());
