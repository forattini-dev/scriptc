// @no-engine
let order = "";
function pair(label: string): [string, number] { order += label; return [label, 2]; }
function names(label: string): [string, string] { order += label; return [label, "end"]; }
console.log("computed", pair("a").length, names("b").length, order);
const holder = { pair: pair("c") };
console.log("nested", holder.pair.length, order);
console.log("sequence", pair("d").length + names("e").length, order);
export {};
