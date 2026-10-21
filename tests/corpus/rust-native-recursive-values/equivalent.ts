// @rust-only
// @no-engine
interface A { next?: A; value: number; }
interface B { value: number; next?: B; }

function asA(value: A): A { return value; }
function asB(value: B): B { return value; }
const b: B = { value: 42 };
b.next = b;
const a: A = asA(b);
console.log(a === b, a.value);
if (a.next !== undefined) {
  console.log(a.next === a, a.next.value);
  a.next.value = 7;
}
console.log(b.value, asB(a) === b);
const other: A = { value: 11 };
a.next = other;
if (b.next !== undefined) console.log(b.next === other, b.next.value);
const erased: any = b;
const checked: A = erased;
console.log(checked === a);
if (checked.next !== undefined) console.log(checked.next.value);
const wide: B & { extra: string } = { value: 1, next: b, extra: "retained" };
const narrow: A = asA(wide);
narrow.value = 9;
console.log(wide.value, wide.extra);
if (narrow.next !== undefined) console.log(narrow.next === b);
