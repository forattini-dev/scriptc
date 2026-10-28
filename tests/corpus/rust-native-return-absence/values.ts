// @rust-only
// @no-engine
const data = new Uint8Array([4]);
function pass(value: number): number { return value; }
function forward(value: number): number { return pass(value); }
const alias = forward;
function run(index: number): void {
  const input = index >= 0 ? data[index]! : 7;
  const output = alias(input);
  console.log('result', output, typeof output, output === undefined, output + 2);
}
run(0);
run(5);
run(-1);
function select(a: number, b: number): number { return a > 0 ? a : b; }
console.log('select', select(data[5]!, 9), select(3, data[5]!));

function inspect(value: number): void { console.log('forwarded', value === undefined, value + 3); }
inspect(forward(data[5]!));
inspect(forward(data[0]!));
