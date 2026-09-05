// A module re-exporting its OWN namespace (the `export * as Ns from "."`
// house style): the namespace object contains itself.
export * as Self from "./self.ts";
export const a = 1;
export function f(): string {
  return "f";
}
