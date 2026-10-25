// @rust-only
// @no-engine
// @ts-nocheck
export {};
let effects = "";
const read = JSON.parse;
function text() { effects = effects + "text;"; return '{"x":1}'; }
function callback() { effects = effects + "callback;"; return function (key, value, context) { effects = effects + "visit:" + key + ";"; return value; }; }
function extra() { effects = effects + "extra;"; return 99; }
console.log("value", read(text(), callback(), extra()).x === 1, effects);
let calls = 0;
try { read('{"x":}', () => { calls++; }); } catch (error) { console.log("syntax", error instanceof SyntaxError, calls === 0); }
try { read('[1,2]', (key, value) => { calls++; throw new Error("reviver-stop"); }); } catch (error) { console.log("throw", error.message === "reviver-stop", calls === 1); }
console.log("ignored", read("1", 3) === 1, read("null", null) === null);
console.log("after", read('{"x":1}', (key, value) => value).x === 1);
