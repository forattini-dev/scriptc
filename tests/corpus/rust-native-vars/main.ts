// @rust-only
// @no-engine
console.log("module before", moduleValue === undefined, readModule() === undefined);
var moduleValue: number | undefined = 7;
console.log("module after", moduleValue, readModule() === 7);
var moduleValue: number | undefined;
if (moduleValue !== undefined) console.log("redeclare", moduleValue);
function readModule(): number | undefined { return moduleValue; }
function local(run: boolean): void {
  console.log("local before", value === undefined);
  if (run) { var value: number | undefined = 3; }
  console.log("local branch", value === undefined);
  if (value !== undefined) console.log("local guarded", value + 1);
  value = 8;
  var value: number | undefined;
  console.log("local assigned", value);
}
local(false);
local(true);
function parameter(value: number): number { var value: number; var value = value + 2; return value; }
console.log("parameter", parameter(4));
function shadow(value: number): number {
  if (true) { let value = 50; console.log("lexical", value); }
  var own = value;
  return own;
}
console.log("shadow", shadow(6));
const callback = (run: boolean): number => {
  if (run) { var result: number | undefined = 9; }
  if (result === undefined) return -1;
  return result;
};
console.log("callback", callback(false), callback(true));
