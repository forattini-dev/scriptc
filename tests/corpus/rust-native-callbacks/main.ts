// @no-engine
export {};
function apply(value: number, callback: (value: number) => number): number {
  return callback(value);
}
function twice(value: number): number { return value * 2; }
function other(value: number): number { return value * 2; }
const alias = twice;
console.log("named", apply(21, alias), twice === alias, twice === other);
console.log("lambda", apply(3, value => value + 4), apply(9, () => 7));
function counter(start: number): () => number {
  let count = start;
  return () => { count = count + 1; return count; };
}
const next = counter(10);
const nextAlias = next;
console.log("escaping", next(), nextAlias(), next === nextAlias);
function siblings(): number {
  let shared = 1;
  const increment = () => { shared = shared + 2; return shared; };
  const read = () => shared;
  shared = 7;
  return increment() + read();
}
function capturedParameter(value: number): number {
  const read = () => value;
  value = value + 4;
  return read();
}
function nested(value: number): () => () => number { return () => () => value; }
console.log("shared", siblings(), capturedParameter(3), nested(42)()());
const first = () => 1;
const second = () => 1;
console.log("identity", first === first, first === second);
function voidCallback(callback: (value: number) => void): void { callback(5); }
voidCallback(value => console.log("void", value));
voidCallback(value => value + 2);
function readInjected(read: () => string | undefined): string | undefined { return read(); }
function optional(flag: boolean): string | undefined { return flag ? "injected" : undefined; }
function report(value: string | undefined): void {
  console.log("injected", value === "injected", value === undefined);
}
report(readInjected(() => optional(true)));
report(readInjected(() => optional(false)));
function recordCallback(): number {
  const record = { count: 1 };
  const mutate = () => { record.count = record.count + 3; return record.count; };
  record.count = 7;
  return mutate();
}
console.log("record", recordCallback());
