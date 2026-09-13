// @rust-only
let seen = "";
function mark(label: string): string { seen += label; return label; }
function combine(a: string, b: number, c: string, d: number, e: string): string {
  return a + b + c + d + e;
}
function* values(): Generator<number, string, number> {
  return combine(mark("A"), yield 1, mark("B"), yield 2, mark("C"));
}
const iterator = values();
console.log(iterator.next(0).value, seen);
console.log(iterator.next(10).value, seen);
console.log(iterator.next(20).value, seen);
let fn: (value: number) => number = (value) => value + 1;
function* throughValue(): Generator<number, number, number> { return fn(yield 3); }
const callable = throughValue();
console.log(callable.next(0).value);
fn = (value) => value + 100;
console.log(callable.next(5).value);
function* print(): Generator<number, void, number> { console.log(mark("D"), yield 4, mark("E")); }
const printer = print();
console.log(printer.next(0).value, seen);
console.log(printer.next(30).done, seen);
