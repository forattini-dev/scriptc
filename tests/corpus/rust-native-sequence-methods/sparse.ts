// @rust-only
// @no-engine
export {};
const values: any[] = [1, 2, 3, 4];
delete values[1];
delete values[3];
let visited = "";
const copy = values.slice();
console.log(copy.length, copy.some((value, index) => { visited = visited + `${index}:${value};`; return false; }), visited);
const mutable = [1, 2, 3];
let calls = "";
console.log(mutable.some((value, index) => {
  calls = calls + `${index}:${value};`;
  if (index === 0) { mutable.pop(); mutable.pop(); mutable.push(9); mutable.push(4); mutable.push(5); }
  return false;
}), calls, mutable.length);
const shrink: any[] = [1, 2, 3];
let count = 0;
console.log(shrink.some(() => { count++; shrink.length = 0; return false; }), count);
const grown: any[] = [7];
grown.length = 4;
let growthCalls = 0;
console.log(grown.some(() => { growthCalls++; return false; }), growthCalls);
