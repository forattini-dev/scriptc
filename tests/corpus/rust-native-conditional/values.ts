// @rust-only
// @no-engine
function truth(value: unknown): string { return value ? "yes" : "no"; }
console.log("falsy", truth(undefined), truth(null), truth(false), truth(0), truth(-0), truth(0 / 0), truth(""), truth(0n));
console.log("truthy", truth(true), truth(1), truth(-1), truth("0"), truth(1n), truth({value: 1}), truth([1]), truth(() => 1), truth(Symbol("key")));
function imageId(value: any): string {
  return Number.isInteger(value) && value && value > 0 ? `,i=${value}` : "auto";
}
console.log("image", imageId(undefined), imageId(0), imageId(-1), imageId(2), imageId("2"));
const left = {value: 1};
const right = {value: 2};
function choose(condition: unknown, a: unknown, b: unknown): unknown { return condition ? a : b; }
console.log("identity", choose(0, left, right) === right, choose(1, left, right) === left);
