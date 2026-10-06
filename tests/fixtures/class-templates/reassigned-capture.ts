function make(tag: string) {
  const C = class { tag(): string { return tag; } };
  tag = tag + "!";
  return C;
}
function run(): string { return new (make("a"))().tag(); }
console.log(run());
