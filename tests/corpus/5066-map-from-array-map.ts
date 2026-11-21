type Surface = {
  path: string;
  format: "npm" | "cargo" | "other";
};

const declared: Surface[] = [
  { path: "packages/a", format: "npm" },
  { path: "crates/b", format: "cargo" },
  { path: "notes/c", format: "other" },
];

const declaredStandard = new Map(
  declared
    .filter((surface) => surface.format === "npm" || surface.format === "cargo")
    .map((surface) => [surface.path, surface.format]),
);

console.log(declaredStandard.get("packages/a") ?? "missing");
console.log(declaredStandard.get("crates/b") ?? "missing");
console.log(declaredStandard.has("notes/c"));
