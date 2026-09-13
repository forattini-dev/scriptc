// @rust-only
function outer<T>(value: T): string {
  const local = <U>(other: U): string => String(value) + ":" + String(other);
  return local(1) + "/" + local("x");
}
console.log(outer(10), outer("base"), outer(true));
