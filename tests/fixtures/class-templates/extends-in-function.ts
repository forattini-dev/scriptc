class Root { value = 1; }
function make(tag: string) {
  const Made = class extends Root { tag(): string { return tag; } };
  return Made;
}
function derive(): number {
  const Local = class extends make("x") {};
  return new Local().value;
}
console.log(derive());
