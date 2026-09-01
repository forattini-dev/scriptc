// URL.canParse(input) — the constructor's accept/reject decision as a
// boolean. Same parser, but it ANSWERS instead of throwing: the one URL entry
// point that never raises. Paired here with the try/catch it replaces so the
// two agree case by case.
function throws(input: string): boolean {
  try {
    new URL(input);
    return false;
  } catch {
    return true;
  }
}

const inputs = [
  "http://example.com/a",
  "https://user:pw@example.com:8443/p?q=1#f",
  "file:///tmp/a.txt",
  "mailto:x@y.com",
  "data:text/plain,hi",
  "ftp://h.com/x",
  "git://h.com:9/x",
  "HTTP://Example.COM/x",
  "  http://a.com/  ",
  "",
  "nope",
  "/relative/path",
  "//example.com/x",
  "http://",
  ":// bad",
  "http://a b.com/",
];
for (const input of inputs) {
  const can = URL.canParse(input);
  console.log(`${can} ${can !== throws(input)} <${input}>`);
}
// It is a plain boolean: usable in conditions and boolean expressions.
console.log(URL.canParse("http://a.com") && !URL.canParse("nope"));
if (URL.canParse("https://x.com/")) console.log("parseable");
const flags: boolean[] = inputs.map((input) => URL.canParse(input));
console.log(flags.filter((flag) => flag).length, flags.length);
// canParse true means the constructor is safe to call.
for (const input of inputs) {
  if (URL.canParse(input)) console.log(new URL(input).protocol);
}
