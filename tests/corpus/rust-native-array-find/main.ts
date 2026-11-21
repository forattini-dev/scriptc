// @rust-only
// @no-engine
export {};

const values: any[] = [1, 2, 3];
let visits = "";
const found = values.find((value: any, index: number, array: any[]): boolean => {
  visits = visits + String(index);
  return array === values && value === 2;
});
console.log("found", found === 2, visits);
console.log("missing", values.find((value: any): boolean => value === 9) === undefined);

const sparse: any[] = [1, 2, 3];
delete sparse[1];
let seen = "";
const hole = sparse.find((value: any, index: number): boolean => {
  seen = seen + String(index);
  return value === undefined;
});
console.log("hole", hole === undefined, seen);
const typed: any[] = [1, 2];
delete typed[0];
let typedVisits = "";
typed.find((value: number, index: number): boolean => {
  typedVisits = typedVisits + (value === undefined ? "u" : "v") + String(index);
  return false;
});
console.log("typed-hole", typedVisits);
const objects: any[] = [{ key: 4 }, { key: 5 }];
const object = objects.find((value: { key: number }): boolean => value.key === 5);
console.log("record", object === objects[1], object.key === 5);
delete objects[0];
try {
  objects.find((value: { key: number }): boolean => value.key === 5);
} catch { console.log("record-hole throws"); }

const changing: any[] = [1, 2, 3];
let calls = 0;
const before = changing.find((value: any, index: number): boolean => {
  calls++;
  if (index === 0) { changing[0] = 9; changing.push(4); return true; }
  return false;
});
console.log("saved", before === 1, changing[0] === 9, calls);

const shrink: any[] = [1, 2, 3];
let shrinkVisits = "";
shrink.find((value: any, index: number): boolean => {
  shrinkVisits = shrinkVisits + String(index) + (value === undefined ? "u" : "v");
  if (index === 0) shrink.length = 0;
  return false;
});
console.log("shrink", shrinkVisits);

const grow: any[] = [1, 2];
let growVisits = "";
grow.find((value: any, index: number): boolean => {
  growVisits = growVisits + String(index);
  if (index === 0) grow.push(3);
  return false;
});
console.log("grow", growVisits, grow.length);

try {
  values.find((value: any): boolean => { throw new Error("callback error"); });
} catch { console.log("throws"); }

let indexVisits = "";
console.log("find-index", values.findIndex((value: any, index: number): boolean => {
  indexVisits += String(index);
  return value === 3;
}), indexVisits);
const sparseIndex: any[] = [1, 2, 3];
delete sparseIndex[1];
let sparseIndexVisits = "";
console.log("find-index-hole", sparseIndex.findIndex((value: any, index: number): boolean => {
  sparseIndexVisits += String(index);
  return value === undefined;
}), sparseIndexVisits);

const listing = "\nfirst\nsecond".split("\n");
console.log("boolean", String(listing.find(Boolean)), listing.findIndex(Boolean));
const booleanSparse: any[] = ["", "kept"];
delete booleanSparse[0];
console.log("boolean-hole", String(booleanSparse.find(Boolean)), booleanSparse.findIndex(Boolean));
