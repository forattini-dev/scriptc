// @rust-only
// @no-engine
export {};
let getter: () => number = () => -1;
for (var j = 0; j < 3; j++) { getter = () => j ?? -1; }
console.log("var", getter(), j);
let count = 0;
for (const tag = 5; count < 2; count++) { getter = () => tag; }
console.log("const", getter(), count);
let total = 0;
for (var k = 2; k >= 0; k--) { if (k !== undefined) total = total + k; }
console.log("descending-var", total, k);
for (let i = 0; i < 3; i++) { const local = i; getter = () => local; }
console.log("body-capture", getter());
