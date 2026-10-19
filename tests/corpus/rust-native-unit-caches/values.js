// @rust-only
// @no-engine
export {};
let cache = null;
function read() { return cache; }
console.log("initial", read() === null, typeof read());
cache = "version";
console.log("string", read() === "version", typeof read());
cache = "";
console.log("empty", read() === "", !!read());
cache = false;
console.log("false", read() === false, !!read());
cache = 0;
console.log("zero", read() === 0, !!read());
cache = undefined;
console.log("undefined", read() === undefined, typeof read());
cache = null;
console.log("cleared", read() === null);
function local() {
  let value = undefined;
  console.log("local initial", typeof value);
  value = "ready";
  console.log("local string", value);
  value = null;
  console.log("local null", value === null);
}
local();
const empty = null;
const absent = undefined;
console.log("constants", empty === null, absent === undefined);
{
  const undefined = "shadow";
  let value = undefined;
  console.log("shadowed undefined", value === "shadow");
}
