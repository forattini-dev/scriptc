// @rust-only
// @no-engine
export {};
let trace = "";
let active: [number, number] = [1, 2];
const original = active;
function receiver(): [number, number] { trace += "receiver;"; return active; }
function key(): number { trace += "key;"; original[1] = 8; active = [30, 40]; return 1; }
console.log("order", receiver()[key()], trace, active[1]);
function fail(): number { trace += "throw;"; throw new Error("index"); }
trace = "";
try { console.log(receiver()[fail()]); }
catch (error) { if (error instanceof Error) console.log("abrupt", true, error.message, trace); }
const first = { value: 3 };
const second = { value: 4 };
const objects: [typeof first, typeof first] = [first, second];
function choose(index: number): void {
  const value = objects[index];
  if (value !== undefined) {
    console.log("identity", value === first, value === second);
    value.value = 9;
  }
}
choose(1);
console.log("owning", first.value, second.value);
