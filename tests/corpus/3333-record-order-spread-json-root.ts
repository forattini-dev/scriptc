// @rust-only
// @no-engine
interface Seed { a: number; b: number }
function seed(reverse: boolean): Seed {
  if (reverse) return { b: 2, a: 1 };
  return { a: 1, b: 2 };
}
const absent = { ...seed(true), text: JSON.stringify(undefined) };
const present = { ...seed(true), text: JSON.stringify(3) };
console.log(Object.keys(absent).join(","), JSON.stringify(absent));
console.log(Object.hasOwn(absent, "text"), typeof absent.text);
console.log(Object.keys(present).join(","), JSON.stringify(present));
const copy = { ...absent };
console.log(Object.keys(copy).join(","), JSON.stringify(copy), typeof copy.text);
