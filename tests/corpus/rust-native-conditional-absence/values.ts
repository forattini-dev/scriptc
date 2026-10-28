// @rust-only
// @no-engine
const data = new Uint8Array([2]);
function inspect(index: number) {
  const value = index >= 0 ? data[index]! : 4;
  const alias = value;
  console.log('value', value, alias === undefined, typeof alias, value + 1);
}
inspect(0);
inspect(3);
inspect(-1);

let order = "";
function yes(): number { order += "y"; return 0; }
function no(): number { order += "n"; return 0; }
const present = true ? data[yes()]! : no();
const missing = false ? no() : data[5]!;
console.log("branches", order, present, missing === undefined);
