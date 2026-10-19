// @rust-only
// @no-engine
let calls = 0;
function argument(): number { console.log("argument"); return 4; }
function defaultValue(): number { console.log("default"); return 7; }
async function calculate(value: number = defaultValue()): Promise<number> {
  calls = calls + 1;
  console.log("body", value, calls);
  return value + calls;
}
async function complete(): Promise<void> { console.log("void body"); }
console.log("before");
const first = calculate(argument());
const second = calculate();
console.log("after", calls, first === second);
first.then(value => { console.log("first", value); });
second.then(value => { console.log("second", value); });
complete().then(() => { console.log("void done"); });
Promise.resolve(0).then(() => { console.log("sibling"); });
console.log("end");
