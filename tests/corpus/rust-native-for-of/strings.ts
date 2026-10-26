// @rust-only
// @no-engine
export {};
for (const value of "a😀é𝄞z") console.log("unicode", value, value.length);
const high = "😀".slice(0, 1);
const low = "😀".slice(1);
for (const value of high + "x" + low + high + low + high) console.log("units", value.length, value.charCodeAt(0));
let text = "abc";
for (const char of text) { console.log("snapshot", char); text = "z"; }
let empty = 0;
for (const char of "") empty++;
console.log("empty-string", empty);
for (const part of ["a", "b"]) {
  for (const char of part) console.log("nested", char);
}
