type Option = { short: string };

const source = new Map<any, any>([
  ["alpha", { short: "a" }],
  ["beta", { short: "b" }],
]);
const copy = new Map<string, Option>(source);

console.log(String(source === (copy as any)));
console.log(`${copy.get("alpha")?.short}|${copy.get("beta")?.short}`);
source.set("alpha", { short: "changed" });
source.set("gamma", { short: "g" });
console.log(`${copy.get("alpha")?.short}|${copy.has("gamma")}`);
