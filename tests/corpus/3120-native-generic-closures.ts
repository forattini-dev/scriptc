// @rust-only
// These calls used to be fenced in generic-value-bindings.ts. Keep runtime
// evidence for each newly admitted shape before retiring those diagnostics.
const curried = <T>(x: T) => <U>(y: U): string => `${x}|${y}`;
console.log(curried(1)("a"));
console.log(curried("b")(2));
const first = curried(10);
const second = curried(20);
console.log(first("x"), second("y"), first("z"));
console.log((<T>(x: T): T => x)(5));
