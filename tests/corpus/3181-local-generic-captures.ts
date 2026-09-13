// @rust-only
interface Tagged {
  <T>(value: T): { value: T; label: string; count: number };
}
function make(label: string): Tagged {
  let count = 0;
  const tag = <T>(value: T): { value: T; label: string; count: number } => {
    count++;
    return { value, label, count };
  };
  console.log(tag(1).count, tag("initial").value);
  const alias = tag;
  return alias;
}
const first = make("first");
const second = make("second");
console.log(first(42).value, first("x").count, second(true).label);
console.log(first(false).count, second(9).count);
function contextual(prefix: string): Tagged {
  const tag: Tagged = (value) => ({ value, label: prefix, count: 1 });
  return tag;
}
console.log(contextual("typed")(7).label);
function nested(seed: number): number {
  let current = seed;
  const add = <T>(value: T): T => { current++; return value; };
  const invoke = (): number => { console.log(add("nested")); return current; };
  console.log(add(3));
  return invoke();
}
console.log(nested(10));
