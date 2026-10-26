export function used(value) { return typeof value === "number"; }
export function acceptsError(value) { return value !== null; }
export function unused() {
  console.log("unused function executed");
  throw new Error("unused function executed");
}
