// @rust-only
// @no-engine
export {};
let order = "";
function initial(): number { order += "i"; return 3; }
function factory(): (value: number) => number { order += "f"; return value => { order += "c"; return value + 1; }; }
const row = [initial(), factory()] as const;
console.log("construct", order);
function source() { order += "s"; return row; }
function argument(): number { order += "a"; return 4; }
console.log("invoke", source()[1](argument()), order);
const [value, callback] = source();
console.log("bind", value, callback(5), order, callback === row[1]);
type Receiver = [number, (value: number) => number];
const receiver: Receiver = [6, function(this: Receiver, value: number): number { return this[0] + value; }];
console.log("receiver", receiver[1](2));
const saved = receiver[1];
console.log("call", saved.call(receiver, 3));
