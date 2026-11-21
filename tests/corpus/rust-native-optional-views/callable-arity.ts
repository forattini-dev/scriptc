function refresh(root?: string): string {
  return root ?? "default";
}

console.log("direct", refresh("custom"));
const options: { refresh: () => string } = { refresh };
console.log("view", options.refresh());
