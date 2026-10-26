const regex = /a/g;
regex.lastIndex = 8;
let seen = "";
console.log("global", "aaa".replace(regex, (match: string, offset: number) => {
  seen = seen + String(regex.lastIndex) + ":" + String(offset) + ";";
  regex.lastIndex = 40 + offset;
  return match.toUpperCase();
}));
console.log("state", seen, regex.lastIndex);
const sticky = /a/y;
sticky.lastIndex = 1;
console.log("sticky", "baab".replace(sticky, (match, offset) => {
  console.log("inside", sticky.lastIndex, offset === 1);
  sticky.lastIndex = 7;
  return "S";
}), sticky.lastIndex);
sticky.lastIndex = 99;
console.log("outside", "a".replace(sticky, () => "wrong"), sticky.lastIndex);
const nested = /a/g;
let count = 0;
console.log("nested", "aa".replace(nested, () => {
  count++;
  if (count === 1) "a".replace(nested, () => { nested.lastIndex = 9; return "i"; });
  return String(nested.lastIndex);
}), nested.lastIndex, count);
try {
  "aa".replace(regex, () => { regex.lastIndex = 13; throw new Error("stop"); });
} catch (error) { console.log("throw", error instanceof Error, regex.lastIndex); }
regex.lastIndex = 17;
console.log("nomatch", "b".replace(regex, () => "wrong"), regex.lastIndex);
