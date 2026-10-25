// @rust-only
// @no-engine
export {};
let descending = "";
const values = ["a", "b", "c"];
for (let i = values.length - 1; i >= 0; i--) { descending = descending + values[i]; }
console.log("descending", descending);
let ascending = "";
for (let i = 0; i < 4; i++) { ascending = ascending + i; }
console.log("ascending", ascending);
let nested = 0;
for (let i = 0; i < 3; i++) { for (let j = 2; j >= 0; j--) { if (j === 1) continue; nested = nested + i + j; } }
console.log("nested", nested);
let i = 2;
for (i = 0; i < 3; i = i + 1) { if (i === 1) continue; }
console.log("assignment", i);
for (let i = 0; i < 1; i++) { console.log("scope", i); }
console.log("outside", i);
let empty = 0;
for (; empty < 2;) empty++;
for (;;) { empty++; break; }
console.log("omitted", empty);
let breaks = 0;
for (let i = 0; i < 1; i = i + 1) { breaks++; break; }
console.log("break", breaks);
