class Root { value = 1; }
function make(tag: string) {
  const Made = class extends Root { tag(): string { return tag; } };
  return Made;
}
class Derived extends make(eval("'a'")) {}
const derived = new Derived();
console.log(derived.tag());
