// @rust-only
// @no-engine
export {};
const row = "ab".match(/(a)?(b)/);
if (row !== null) console.log(row.length, row[0], row[1], row[2], row.index, row.input);
const absent = "b".match(/(a)?b/);
if (absent !== null) console.log(absent[1] === undefined, absent[0], absent.index);
console.log("abc".match(/z/) === null);
const global = /a/g;
global.lastIndex = 5;
const all = "aba".match(global);
if (all !== null) console.log(all.length, all[0], all[1], all.index === undefined, all.input === undefined);
console.log("global-state", global.lastIndex);
const sticky = /a/y;
sticky.lastIndex = 1;
const found = "ba".match(sticky);
if (found !== null) console.log("sticky", found[0], found.index, sticky.lastIndex);
const source = "😀a".match(/a/);
if (source !== null) console.log("unicode-index", source.index);
let text = "abc";
function separator(): RegExp { text = "changed"; return /b/; }
const ordered = text.match(separator());
if (ordered !== null) console.log("order", ordered[0], ordered.input, text);
