// @rust-only
// @no-engine
// @ts-nocheck
export {};
const holder: {"": unknown} = {"": 1};
let key = "";
holder[key] = "changed";
console.log("replacement", holder[key] === "changed", Object.keys(holder).join("|") === "");
const child = {value: 8};
key = "child";
holder[key] = child;
console.log("identity", holder[key] === child, holder[key].value === 8, Object.keys(holder).join("|"));
const array = [2, 3];
key = "array";
holder[key] = array;
console.log("array", holder[key] === array, holder[key][1] === 3);
let trace = "";
function receiver() { trace = trace + "receiver;"; return holder; }
function property(): string { trace = trace + "key;"; return "slot"; }
function value(): number { trace = trace + "value;"; return 9; }
receiver()[property()] = value();
console.log("order", trace, holder["slot"] === 9);
key = "void";
holder[key] = undefined;
console.log("undefined", holder[key] === undefined, Object.hasOwn(holder, "void"));
