function snapshot(values?: readonly string[]): string[] {
  if (values === undefined) return [];
  return [...values];
}

console.log(snapshot(["first", "second"]).join(","));
console.log(snapshot().length);
