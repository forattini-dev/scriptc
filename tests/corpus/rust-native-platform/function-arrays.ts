// @ts-nocheck
type TextFn = (value: string) => string;
function suffix(value: string): string { return value + "!"; }
function prefix(value: string): string { return "[" + value + "]"; }
const functions: TextFn[] = [suffix, prefix];
const alias = functions;
console.log("identity", functions[0] === suffix, alias === functions);
console.log("call", functions[0]("x"), functions[1]("x"));
functions.push(suffix);
console.log("reduce", functions.reduce((value, fn) => fn(value), "x"));
function cycle(): string {
  const values: TextFn[] = [];
  const callback: TextFn = (text) => text + values.length;
  values.push(callback);
  return values[0]("cycle");
}
console.log("cycle", cycle());
const pieces: string[] = ["a"];
pieces.length = 3;
pieces[2] = "c";
console.log("sparse", pieces.reduce((left, right) => left + right));
const mutating: string[] = ["a", "b", "c"];
console.log("mutation", mutating.reduce((left, right, index) => {
  if (index === 0) { mutating.length = 1; mutating.push("d"); }
  return left + right;
}, ""));
try { ([] as string[]).reduce((left, right) => left + right); }
catch (error) { console.log("empty", error instanceof TypeError, String(error.message)); }
function flexible(seed: any): any {
  return [1, 2].reduce((acc: any, item: number): any =>
    typeof acc === "string" ? item : acc + item, seed);
}
console.log("dynamic", String(flexible("seed")), String(flexible(10)));
