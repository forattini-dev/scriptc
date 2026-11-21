const source: Readonly<Record<string, string>> = {
  first: "one",
  second: "two",
};

const result: Readonly<Record<string, string>> = {
  ...source,
  second: "overridden",
  third: "three",
};

console.log(result.first);
console.log(result.second);
console.log(result.third);
