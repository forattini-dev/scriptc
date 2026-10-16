// @rust-only
// @no-engine
console.log("before", pending === undefined);
/** @type {any} */
var pending = new Map();
function reset() { pending = undefined; }
function read() { return pending; }
function put() { pending.set("key", "value"); }
put();
console.log("after", pending.get("key") === "value", read() === pending);
reset();
console.log("reset", pending === undefined);
/** @type {any} */
var pending = new Map();
put();
console.log("again", pending.get("key") === "value");
