const output = "a b ab".replace(/(a)|(b)/g, (match, a, b, offset, input) => {
  console.log("capture", match, a === undefined, b === undefined, offset === 0, input === "a b ab");
  return a === undefined ? "B" : "A";
});
console.log("output", output);
console.log("empty", "ab".replace(/(a*)(b?)/, (match, a, b) => String(a) + ":" + String(b)));
console.log("literal", "aa".replace(/a/g, () => "$&$1$$"));
console.log("none", "xyz".replace(/(a)/g, () => { console.log("unexpected"); return "!"; }));
const MAX_INT = "9007199254740991";
const large = "[123,9007199254740992,1.5,2e10,\"123\"]".replace(
  /"(?:[^"\\]|\\.)*"|(-?\d+)(\.\d+)?([eE][+-]?\d+)?/g,
  (match, digits, fractional, exponential) => {
    const isString = match[0] === '"';
    const isStandard = isString || fractional || exponential ||
      (digits && (digits.length < MAX_INT.length || (digits.length === MAX_INT.length && digits <= MAX_INT)));
    if (isStandard) return match;
    return '"' + match + 'n"';
  },
);
console.log("large", large);
