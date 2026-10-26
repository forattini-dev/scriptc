// @rust-only
// @no-engine
export {};
const saved = {first: () => -1, second: () => -1, last: () => -1};
for (const value of [1, 2, 3]) {
  if (value === 1) saved.first = () => value;
  if (value === 2) saved.second = () => value;
  if (value === 3) saved.last = () => value;
}
console.log("const-cells", saved.first(), saved.second(), saved.last());
const mutable = {first: () => -1, second: () => -1, last: () => -1};
for (let value of [1, 2, 3]) {
  if (value === 1) mutable.first = () => value;
  if (value === 2) mutable.second = () => value;
  if (value === 3) mutable.last = () => value;
  value = value + 10;
}
console.log("let-cells", mutable.first(), mutable.second(), mutable.last());
const nested = {a: () => "", b: () => ""};
for (const outer of ["x", "y"]) {
  for (const inner of [1, 2]) {
    if (outer === "x" && inner === 2) nested.a = () => outer + inner;
    if (outer === "y" && inner === 1) nested.b = () => outer + inner;
  }
}
console.log("nested-cells", nested.a(), nested.b());
