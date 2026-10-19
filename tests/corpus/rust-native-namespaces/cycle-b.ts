import * as a from "./cycle-a.ts";
export const other = a;
export let value: number = 2;
export function set(next: number): void { value = next; }
