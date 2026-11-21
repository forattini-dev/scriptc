const entries = new Map<string, number>();
entries.set("first", 1);
entries.set("second", 2);

console.log(entries.keys().next().value ?? "none");
entries.delete("first");
console.log(entries.keys().next().value ?? "none");
entries.clear();
console.log(entries.keys().next().value ?? "none");
