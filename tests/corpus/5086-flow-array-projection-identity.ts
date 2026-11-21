function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function strings(value: unknown): readonly string[] {
  const stored = value;
  if (isStringArray(stored)) return stored;
  return [];
}

console.log(`empty:${strings("no").join(",")}`);
