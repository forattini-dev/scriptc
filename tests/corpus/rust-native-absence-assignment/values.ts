// @rust-only
// @no-engine
const bytes = new Uint8Array([5]);
function run(index: number): void {
  let value: number;
  switch (index) {
    case 0: value = 3; break;
    default: value = bytes[index]!; break;
  }
  console.log('value', value, typeof value, value === undefined, value + 1);
  value = 8;
  console.log('after', value, value + 1);
}
run(0);
run(4);
let initial: number = 2;
initial = bytes[9]!;
console.log('initialized', initial, initial === undefined, initial + 1);

let shared: number = 6;
function change(): void { shared = bytes[8]!; }
function plusOne(value: number): number { return value + 1; }
change();
console.log('shared', shared === undefined, plusOne(shared));
