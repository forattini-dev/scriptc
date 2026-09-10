// @dynamic
// @no-engine
// Dynamic inputs keep Number's non-coercing predicates in native Rust.
function check(value: any): void {
  console.log(Number.isInteger(value), Number.isSafeInteger(value));
}
check(42);
check(-0);
check(1.5);
check(9007199254740991);
check(9007199254740992);
check(NaN);
check(Infinity);
check("42");
check(true);
check(null);
check(undefined);
let calls = 0;
function next(): any {
  calls++;
  return 3.25;
}
console.log(Number.isInteger(next()), calls);
console.log(Number.isSafeInteger(next()), calls);
