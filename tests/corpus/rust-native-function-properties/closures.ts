export {};
type Callback = (value: number) => number;
function make(offset: number): Callback {
  const fn = (value: number): number => value + offset;
  const data: any = fn;
  data.label = offset;
  return fn;
}
const a = make(2);
const b = make(7);
const first: any = a;
const second: any = b;
console.log("independent", a !== b, first.label === 2, second.label === 7, a(3), b(3));
first.label = "changed";
const alias: any = a;
console.log("alias", alias.label === "changed", second.label === 7);
function choose(value: Callback): Callback { return value; }
const returned: any = choose(a);
console.log("returned", returned === first, returned.label === "changed");
first.self = a;
second.peer = a;
console.log("cycle", first.self === a, second.peer === a);
const bound = a.bind(undefined);
const boundData: any = bound;
console.log("bound", bound !== a, boundData.label === undefined, bound(3));
boundData.label = "bound";
console.log("separate", boundData.label === "bound", first.label === "changed");
