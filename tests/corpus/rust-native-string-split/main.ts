// @rust-only
// @no-engine
export {};
const path = "alpha.beta..gamma.";
const parts = path.split(".");
console.log("path", parts.length, parts.join("|"));
console.log("missing", "abc".split("x").join("|"));
console.log("empty", "".split("").length, "".split("x").length);
const text = "A😀" + String.fromCharCode(0xd800);
const units = text.split("");
console.log("units", units.length);
for (const unit of units) console.log(unit.length, unit.charCodeAt(0));
let source = "first.second";
function separator(): string { source = "changed"; return "."; }
const saved = source.split(separator());
console.log("effects", saved.join("|"), source);
const separate = path.split(".");
parts[0] = "changed";
console.log("identity", parts === separate, separate.join("|"));
