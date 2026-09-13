console.log("literal", /a/g.test("ba"), /a/y.test("ba"));
const re = /(a)(b)?/g;
const alias = re;
for (let i = 0; i < 4; i++) {
  const row = alias.exec("a ab");
  console.log("exec", row === null ? "null" : row[0], row === null ? "none" : row[2], re.lastIndex);
  if (row) console.log("metadata", row.index, row.input);
}
const sticky = /a/y;
sticky.lastIndex = 1;
console.log("sticky", sticky.test("ba"), sticky.lastIndex, sticky.test("ba"), sticky.lastIndex);
for (const index of [-2.5, 1.9, NaN, Infinity, 99]) {
  re.lastIndex = index;
  console.log("assigned", re.lastIndex);
  console.log("tested", re.test("ba"), re.lastIndex);
}
const unicode = /./gu;
unicode.lastIndex = 1;
const unicodeRow = unicode.exec("😀z");
if (unicodeRow) console.log("unicode", unicodeRow[0], unicodeRow.index, unicode.lastIndex);
const empty = /(?:)/g;
console.log("empty", empty.test("x"), empty.lastIndex, empty.test("x"), empty.lastIndex);
const ordinary = /(a)/;
ordinary.lastIndex = 12.5;
const ordinaryRow = ordinary.exec("ba");
if (ordinaryRow) console.log("ordinary", ordinaryRow[0], ordinaryRow.index, ordinary.lastIndex);
let evaluations = 0;
function receiver(): RegExp { evaluations++; return re; }
console.log("assignment", receiver().lastIndex = 1.5, evaluations, re.lastIndex);

console.log("fresh", /a/g.test("a"), /a/g.test("a"));
const unicodeSticky = /./uy;
unicodeSticky.lastIndex = 1;
console.log("unicode sticky", unicodeSticky.test("😀"), unicodeSticky.lastIndex);
let selected = /a/g;
const original = selected;
function getRegex(): RegExp { console.log("receiver"); return selected; }
function getSubject(): string { console.log("subject"); selected = /b/g; return "a"; }
const ordered = getRegex().exec(getSubject());
if (ordered) console.log("order", ordered[0], original.lastIndex, selected.lastIndex);

const rows = [..."a ba".matchAll(/a/g)];
console.log("stored matches", rows[1].index, rows[1].input);
