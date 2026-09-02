function resolve(argv: readonly string[]): string {
  const first = argv[0];
  if (first === "--full" || first === "--brief" || first === "--terse") {
    return first.slice(2);
  }
  if (!first || first.startsWith("-")) return "none";
  return first;
}

console.log(resolve([]));
console.log(resolve(["--brief"]));
console.log(resolve(["command"]));
