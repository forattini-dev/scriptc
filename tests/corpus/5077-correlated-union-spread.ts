type Value = string[] | boolean | number | string;

function append(existing: Value, coerced: Value): void {
  if (Array.isArray(existing)) {
    // TypeScript cannot express the correlation established by the schema.
    // @ts-ignore
    existing.push(...coerced);
    console.log(existing.length);
  }
}

append([], ["a", "b"]);
