// @rust-only
// @no-engine
const stringify = JSON.stringify;
const parse = JSON.parse;
console.log("missing", stringify() === undefined, stringify(undefined, null, true) === undefined);
console.log("ignored", stringify({a: 1}, {}, {}) === '{"a":1}');
console.log("coercion", parse(42) === 42, parse(true) === true, parse(null) === null);
try { parse(); } catch (error) { console.log("syntax", error instanceof SyntaxError); }
