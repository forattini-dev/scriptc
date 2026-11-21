/** @type {Map<any, any>} */
const source = new Map([
  ["alpha", { short: "a" }],
  ["beta", { short: "b" }],
]);

/** @type {Map<string, { short: string }>} */
const copy = new Map(source);
console.log(`${copy.get("alpha")?.short}|${copy.get("beta")?.short}`);
