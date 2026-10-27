// @rust-only
// @no-engine
export {};

function collect(source: any): string {
  let output = "";
  for (const item of source) output += String(item) + "|";
  return output;
}
console.log("strings", collect("a😀z"), collect(""));
console.log("arrays", collect([1, 2, 3]), collect([]));
console.log("tuple", collect(["x", 3, true] as const));
console.log("bytes", collect(new Uint8Array([2, 255])));
console.log("float", collect(new Float32Array([1.5, -2])), collect(new Float64Array([3.25])));
const high = "😀".slice(0, 1);
const low = "😀".slice(1);
function units(source: any): void {
  for (const item of source) {
    const text = String(item);
    console.log("unit", text.length, text.charCodeAt(0));
  }
}
units(high + "x" + low + high + low + high);

let evaluations = 0;
const live = [1, 2, 3];
function input(): any { evaluations++; return live; }
let output = "";
for (const item of input()) {
  output += String(item) + ",";
  if (item === 1) { live[1] = 20; live.push(4); }
}
console.log("live", output, evaluations);
const view = new Float32Array([1, 2, 3]);
function mutate(source: any): string {
  let output = "";
  for (const item of source) {
    output += String(item) + ",";
    if (item === 1) view[1] = 9;
  }
  return output;
}
console.log("view", mutate(view));

function union(source: string | number[]): string {
  let output = "";
  for (const item of source) output += String(item);
  return output;
}
console.log("union", union("😀x"), union([4, 5]));

function capture(source: any): void {
  const saved = { first: () => "", last: () => "" };
  for (let item of source) {
    if (item === 1) saved.first = () => String(item);
    saved.last = () => String(item);
    item = Number(item) + 10;
  }
  console.log("capture", saved.first(), saved.last());
}
capture([1, 2, 3]);

function control(source: any): string {
  for (const item of source) {
    try {
      if (item === 1) continue;
      if (item === 3) break;
      return String(item);
    } finally { console.log("finally", String(item)); }
  }
  return "empty";
}
console.log("return", control([1, 2, 3]));
console.log("break", control([1, 3, 4]));
console.log("empty", control([]));
function invalid(source: any): void {
  try { for (const item of source) console.log("unreachable", String(item)); }
  catch (error) { console.log("invalid", error instanceof TypeError); }
}
invalid(null);
invalid(undefined);
invalid(3);
invalid({length: 0});
