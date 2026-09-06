// The island module (Proxy keeps it there), reached ONLY through
// `import()` from static code — red-dev's lazy-command architecture:
// the module evaluates when first imported, never at start-up.
const guard = new Proxy({ on: true }, {});
console.log("lazy: evaluated");
export const label = "lazy module";
export function describe(x: number): string {
  return `${label} saw ${x}${(guard as { on: boolean }).on ? "" : "?"}`;
}
