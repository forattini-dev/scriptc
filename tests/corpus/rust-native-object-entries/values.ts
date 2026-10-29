const source: Record<string, number> = { z: 3, "10": 10, "2": 2, a: 1 };
const entries = Object.entries(source);
console.log("order", entries.map(([key, value]) => key + ":" + value).join(","));
source.z = 7;
console.log("snapshot", entries[2][1], Object.entries(source)[2][1]);
console.log("empty", Object.entries({}).length);
const definitions: Record<string, { enabled: boolean }> = { ":": { enabled: true }, "::": { enabled: false } };
const normalized = Object.entries(definitions)
  .map((pair) => ({ separator: pair[0]!, enabled: pair[1]!.enabled }))
  .sort((a, b) => b.separator.length - a.separator.length);
console.log("chain", normalized[0].separator, normalized[1].separator, normalized[0].enabled);
