// @rust-only
// @no-engine
export {};
class Base {
  stored = 2;
  [Symbol.iterator](value: number): number { return this.stored + value; }
  read(): number { return this[Symbol.iterator](3); }
}
class Child extends Base {
  [Symbol.iterator](value: number): number { return super[Symbol.iterator](value) + 10; }
}
class Grandchild extends Child {
  [Symbol.iterator](value: number): number { return super[Symbol.iterator](value) + 100; }
}
class Inherited extends Child {}
class Sibling extends Base {}
function show(value: Base): void { console.log(value[Symbol.iterator](4), value.read()); }
show(new Base());
show(new Child());
show(new Grandchild());
show(new Inherited());
show(new Sibling());
