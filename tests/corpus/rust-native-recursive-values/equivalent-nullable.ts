// @rust-only
// @no-engine
interface A { next?: A; value: number; }
interface B { value: number; next?: B; }
function project(value: B | undefined | null): A | null | undefined { return value; }
const b: B = { value: 5 };
b.next = b;
function check(value: B | undefined | null): void {
  const a = project(value);
  console.log(a === value);
  if (a) {
    console.log(a.value);
    if (a.next !== undefined) console.log(a.next === a);
    a.value = 12;
  }
}
check(b);
check(undefined);
check(null);
console.log(b.value, project(null) === null, project(undefined) === undefined);
