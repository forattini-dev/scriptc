import "./cycle-b.ts";
export let memo: string | undefined;
console.log("a initialized", memo === undefined);
export function write(value: string): void { memo = value; }
