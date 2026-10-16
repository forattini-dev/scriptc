import { right } from "./right.ts";
export function left(value: number): number {
  if (value <= 0) { return 0; }
  return 1 + right(value - 1);
}
export const leftValue = 1;
console.log("left initialized");
