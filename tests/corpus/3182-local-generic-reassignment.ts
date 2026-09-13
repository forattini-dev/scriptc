// @rust-only
function run(prefix: string): void {
  let fn = <T>(value: T): string => prefix + String(value);
  const alias = fn;
  console.log(fn(1), fn("a"));
  fn = <T>(value: T): string => prefix.toUpperCase() + String(value);
  console.log(fn(2), alias(3));
  var local = <T>(value: T): T => value;
  console.log(local(5), local("var"));
}
run("one:");
run("two:");
