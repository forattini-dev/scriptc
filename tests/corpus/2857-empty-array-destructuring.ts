function route(argv: readonly string[]): string {
  const [first, ...rest] = argv;
  if (first !== undefined) return `${first}:${rest.join(",")}`;
  return `default:${rest.length}`;
}

console.log(route([]));
console.log(route(["run", "one"]));
