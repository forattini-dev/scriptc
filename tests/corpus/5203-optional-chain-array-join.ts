interface Group {
  reasons: string[];
}

function describe(group?: Group): string {
  return group?.reasons.join(", ") ?? "absent";
}

console.log(describe({ reasons: ["native", "rust"] }));
console.log(describe());
