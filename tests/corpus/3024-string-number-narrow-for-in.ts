type RelayHeaders = Record<string, string | string[] | number | undefined>;

function relayHeaders(source: RelayHeaders, strip: Set<string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name in source) {
    const value = source[name];
    if (value === undefined || strip.has(name.toLowerCase())) continue;
    if (typeof value === "string") {
      headers[name] = value;
    } else if (typeof value === "number") {
      headers[name] = String(value);
    } else {
      headers[name] = value.join(", ");
    }
  }
  return headers;
}

console.log(JSON.stringify(relayHeaders({ a: 1, b: ["x", "y"], c: "plain", d: undefined, E: 2 }, new Set(["e"]))));
