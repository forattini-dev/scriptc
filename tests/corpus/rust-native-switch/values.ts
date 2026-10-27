// @rust-only
// @no-engine
export {};
function select(value: any): string {
  let output = "";
  switch (value) {
    case 0: output += "zero";
    case 1: output += "one"; break;
    default: output += "default";
    case "x": output += "x";
    case false: output += "false"; break;
    case true: output += "true";
  }
  return output;
}
console.log("values", select(0), select(1), select("1"), select("x"), select(false), select(true), select(null), select(undefined));
console.log("nan", select(Number("bad")), select(-0));
let effects = 0;
function empty(): void { effects++; }
switch (empty()) {}
console.log("empty", effects);
function complete(value: number): string {
  switch (value) { case 1: return "one"; default: return "other"; }
}
console.log("complete", complete(1), complete(4));
function miss(value: number): string {
  let missing = "miss";
  switch (value) { case 1: missing = "wrong"; }
  return missing;
}
console.log(miss(2));
