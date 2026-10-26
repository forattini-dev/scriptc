// @rust-only
// @no-engine
// @ts-nocheck
export {};
const values: number[] = [2, 4, 6];
let visits = "";
console.log("all", values.every((value: number, index: number, array: number[]): boolean => {
  visits = visits + String(index);
  return value % 2 === 0 && array === values;
}), visits);
visits = "";
console.log("stop", values.every((value: number, index: number): boolean => { visits = visits + String(index); return value < 4; }), visits);
console.log("empty", ([] as number[]).every((): boolean => false));
console.log("truthy", values.every((value: number): any => "yes"), values.every((value: number): any => 0));
const readonly: readonly number[] = values;
console.log("readonly", readonly.every((value: number): boolean => value > 0));
