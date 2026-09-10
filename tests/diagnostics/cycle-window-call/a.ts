import { bee } from "./b.ts";
export function aye(n: number): number {
  return n <= 0 ? 0 : bee(n - 1) + offset;
}
console.log("a-init", aye(2));
// Unlike a call using only hoisted functions and parameters, this call reads
// a lexical binding before initialization. Keep the unsafe init-window fence.
const offset: number = 1;
