class Known extends Error {
  override toString(): string { return "known"; }
}
const render = (error: Error): string => error.toString();
const Late = class extends Error {
  override toString(): string { return "late"; }
};
console.log(render(new Known("ignored")));
console.log(render(new Late("ignored")));
