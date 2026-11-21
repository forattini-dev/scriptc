function extractTest(pattern: RegExp): RegExp["test"] {
  return pattern.test;
}

const test = extractTest(/native/);
console.log(test.call(/native/, "native"));
console.log(test.call(/native/, "other"));
