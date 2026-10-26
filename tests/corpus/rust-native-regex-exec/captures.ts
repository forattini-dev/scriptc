// @rust-only
// @no-engine
export {};
const match = /(a)?(b*)/.exec("xxb");
if (match !== null) {
  const absent = match[1];
  console.log(match.length, match[0] === "", absent === undefined, match[2] === "", match[99] === undefined);
  console.log(match.index, match.input);
  const alias = match;
  console.log(alias === match, alias[1] === undefined);
}
console.log(/z/.exec("abc") === null);
const named = /(?<first>a)?(?<last>b)/.exec("b");
if (named !== null) console.log("named", named[0], named[1] === undefined, named[2], named.index, named.input);
function capture(): RegExpExecArray {
  const row = /(a)?b/.exec("b");
  if (row === null) throw new Error("missing match");
  return row;
}
const row = capture();
console.log(row[1] === undefined, row[99] === undefined, row.index, row.input);
const negative = row[-1];
const fractional = row[0.5];
const outOfRange = 99;
const missing = row[outOfRange];
console.log(negative === undefined, fractional === undefined, missing === undefined);
const erased: any = row;
console.log(erased.index === 0, erased.input === "b");
