// @rust-only
// @no-engine
function cycle(): () => number {
  let callback: () => number = () => 1;
  const record = { run: () => 2 };
  const use = () => record.run();
  record.run = () => callback();
  callback = use;
  return use;
}
const cyclic = cycle();
console.log("cycle identity", cyclic === cyclic);
function shared(): () => number {
  let callback = () => 3;
  const first = () => callback();
  const second = () => callback();
  callback = () => 7;
  console.log("shared cell", first(), second());
  return first;
}
console.log("escaped cell", shared()());
console.log("var before", optional === undefined);
var optional: (() => number) | undefined;
optional = () => 9;
if (optional !== undefined) console.log("var callback", optional());
var callback = () => 1;
console.log("hoisted callback", callback());
function outer(): number { const f = () => 1; const g = () => f(); return g(); }
console.log("function capture", outer());
function optionalParam(n?: () => number): number { if (n === undefined) return -1; return n(); }
console.log("optional parameter", optionalParam(), optionalParam(() => 5));
