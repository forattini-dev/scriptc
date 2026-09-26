function optionalPosition(start = 0, end?: number): void {
  const text = "aéΩbc";
  console.log(text.charCodeAt(start), text.charAt(start), "a😀bc".charCodeAt(start));
  console.log(text.slice(start, end), text.substring(start, end));
}
optionalPosition();
optionalPosition(3);
optionalPosition(3, 4);
optionalPosition(undefined, 0);
for (const start of [NaN, Infinity, -Infinity, -0, -1.9, 1.9, 99]) {
  optionalPosition(start, undefined);
  optionalPosition(start, NaN);
}

let calls = 0;
function position(value?: number): number | undefined { calls++; return value; }
console.log("abcd".substring(3, position()), calls);
console.log("abcd".slice(position(1), position(3)), calls);
