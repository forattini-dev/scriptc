// @rust-only
// @no-engine
export {};

const values: any[] = [1, 2, 3];
delete values[1];
let visits = "";
const selected = values.filter((value: any, index: number, array: any[]) => {
  visits += String(index);
  if (index === 0) {
    array[1] = 8;
    array.push(4);
  }
  return value === 1 || value === 8 || value === 4;
});
console.log("filter-live", selected.join(","), visits, values.length);

const shrinking: any[] = [1, 2, 3];
let shrinkVisits = "";
const shrunk = shrinking.filter((value: any, index: number) => {
  shrinkVisits += String(index);
  if (index === 0) shrinking.length = 1;
  return value;
});
console.log("filter-shrink", shrunk.join(","), shrinkVisits);
