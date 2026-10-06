function outer(tag: string) {
  const Inner = class { tag(): string { return tag; } };
  return class extends Inner { more(): string { return tag + "!"; } };
}
function run(): string { return new (outer("a"))().more(); }
console.log(run());
