const render = (error: Error): string => error.toString();
const Late = class extends Error {
  override toString(): string { return "late"; }
};
console.log(render(new Late("ignored")));
