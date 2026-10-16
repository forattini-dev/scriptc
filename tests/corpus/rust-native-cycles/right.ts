import { left } from "./left.ts";
export function right(value: number): number {
  if (value <= 0) { return 0; }
  return 1 + left(value - 1);
}
export const rightValue = 2;
console.log("right initialized");
