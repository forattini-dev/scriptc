// @rust-only
// @no-engine
// @ts-nocheck
export {};
const values: any[] = [1, 2, 3, 4];
delete values[1];
let visits = "";
console.log("holes", values.every((value: any, index: number): boolean => { visits = visits + String(index); return true; }), visits);
const changing: any[] = [1, 2, 3];
visits = "";
console.log("mutation", changing.every((value: any, index: number): boolean => {
  visits = visits + String(index);
  if (index === 0) { delete changing[1]; changing[2] = 9; changing[3] = 10; }
  return value < 10;
}), visits);
const shrinking: any[] = [1, 2, 3];
visits = "";
console.log("shrink", shrinking.every((value: any, index: number): boolean => {
  visits = visits + String(index); shrinking.length = 0; return true;
}), visits);
