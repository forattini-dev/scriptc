// @rust-only
// @no-engine
// Global and sticky regexes keep lastIndex between test() and exec() calls.
const words = /a(b)?/g;
const text = "ab a ab";
let match: RegExpExecArray | null;
while ((match = words.exec(text)) !== null) {
  console.log(match[0], match[1], match.index, words.lastIndex);
}
console.log(words.lastIndex, words.exec(text) === null, words.lastIndex);

const sticky = /x/y;
console.log(sticky.test("xx"), sticky.lastIndex, sticky.test("xx"), sticky.lastIndex, sticky.test("xx"), sticky.lastIndex);

const digits = /\d+/g;
digits.lastIndex = 3;
const found = digits.exec("12 345 6");
if (found !== null) console.log(found[0], found.index, digits.lastIndex);
else console.log("none");
digits.lastIndex = 0;
let total = 0;
let part: RegExpExecArray | null;
while ((part = digits.exec("12 345 6")) !== null) total += Number(part[0]);
console.log(total, digits.lastIndex);

const plain = /b/;
console.log(plain.test("abc"), plain.lastIndex, plain.test("abc"), plain.lastIndex);
const first = plain.exec("abcb");
if (first !== null) console.log(first[0], first.index);
else console.log("none");

const named = /(?<year>\d{4})-(?<month>\d{2})/g;
const dates = "2024-07 and 2025-08";
let date: RegExpExecArray | null;
while ((date = named.exec(dates)) !== null) {
  console.log(date[0], date.index, date.input, named.lastIndex);
  console.log(date.groups?.year, date.groups?.month);
}
