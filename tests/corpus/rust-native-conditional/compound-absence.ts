// @rust-only
// @no-engine
// @ts-nocheck
var empty: number;
console.log("hoisted", empty += 2, empty);
let value: number | undefined = 4;
function reset(): number { value = undefined; return 3; }
console.log("captured old", value *= reset(), value);
value = undefined;
console.log("undefined", value -= 1, value);
function noValue(): void { console.log("void right"); value = 100; }
value = 5;
console.log("void result", value += noValue(), value);
let right: number | undefined;
let number = 8;
console.log("undefined right", number /= right, number);
