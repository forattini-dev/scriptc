const values = new Map<string, string>([
  ["alpha", "native"],
  ["beta", "rust"],
]);

console.log([...values].map(([key, value]) => `${key}:${value}`).join(","));
