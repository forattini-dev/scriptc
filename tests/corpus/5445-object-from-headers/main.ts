const headers = new Headers([
  ["z-last", "last"],
  ["a-first", "one"],
  ["A-FIRST", "two"],
]);

const object: Record<string, string> = Object.fromEntries(headers as any);
console.log(JSON.stringify(object));
console.log(Object.keys(object).join(","));
