// @rust-only
// @no-engine
export {};
const input = "A😀" + String.fromCharCode(0xd800) + "B" + String.fromCharCode(0xdc00);
const pieces: string[] = [...input];
console.log("count", pieces.length);
for (const part of pieces) console.log("unit", part.length, part.charCodeAt(0));
const empty: string[] = [...""];
console.log("empty", empty.length);
let value = "xy";
function change(): string { value = "changed"; return "!"; }
const snapshot: string[] = ["<", ...value, change(), ..."😀", ">"];
console.log("snapshot", snapshot.join("|"), value);
const again: string[] = [...input];
pieces[0] = "z";
console.log("identity", pieces === again, again.join("|") === pieces.join("|"));
