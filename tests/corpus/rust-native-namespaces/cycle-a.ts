import * as b from "./cycle-b.ts";
export const other = b;
export let value: number = 1;
export function update(value: number): void { b.set(value); }
