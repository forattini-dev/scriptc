// @rust-only
// @no-engine
const data = new Uint8Array([2]);
function observe(value: number): void {
  console.log('received', value === undefined, typeof value, value + 1);
}
const alias = observe;
function forward(value: number): void { alias(value); }
function run(index: number): void {
  const value = index >= 0 ? data[index]! : 4;
  forward(value);
}
run(0);
run(3);
run(-1);
// The initial numeric call must not freeze the ABI before the absent call.
observe(9);
let order = "";
function index(): number { order += "i"; return 10; }
function fallback(): number { order += "f"; return 4; }
const fromCall = true ? data[index()]! : fallback();
observe(fromCall);
console.log("order", order);
