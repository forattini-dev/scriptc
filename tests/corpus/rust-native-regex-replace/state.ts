// @rust-only
// @no-engine
const global = /a/g;
const alias = global;
global.lastIndex = 2;
console.log("global", "aba".replace(global, "x"), alias.lastIndex);
alias.lastIndex = 1;
console.log("all global", "aba".replaceAll(alias, "y"), global.lastIndex);
const single = /a/;
single.lastIndex = 2;
console.log("single", "aba".replace(single, "x"), single.lastIndex);
const sticky = /a/y;
sticky.lastIndex = 1;
console.log("sticky", "baa".replace(sticky, "x"), sticky.lastIndex);
sticky.lastIndex = 0;
console.log("sticky miss", "baa".replace(sticky, "x"), sticky.lastIndex);
try { "aba".replaceAll(single, "x"); }
catch (error) { console.log("nonglobal", error instanceof TypeError, single.lastIndex); }
function substitute(text: string, pattern: RegExp): string { return text.replace(pattern, "[$&]"); }
const record = { pattern: /b/g };
console.log("stored", substitute("aba", record.pattern), record.pattern.lastIndex);
