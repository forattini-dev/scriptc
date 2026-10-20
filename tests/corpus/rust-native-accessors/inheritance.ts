// @rust-only
// @no-engine
export {};
class Base {
  stored = 1;
  constructor() { this.value = 2; }
  get value(): number { console.log("base get"); return this.stored; }
  set value(value: number) { console.log("base set", value); this.stored = value; }
  read(): number { return this.value; }
}
class Child extends Base {
  get value(): number { console.log("child get"); return super.value + 10; }
  set value(value: number) { console.log("child set", value); super.value = value + 1; }
}
class Grandchild extends Child {
  get value(): number { console.log("grand get"); return super.value + 100; }
  set value(value: number) { console.log("grand set", value); super.value = value + 100; }
}
class Inherited extends Child {}
const direct = new Child();
console.log("direct", direct.value, (direct.value = 5), direct.value);
function show(value: Base): void {
  console.log("read", value.value, value.read());
  console.log("write", (value.value = 4));
  console.log("after", value.value);
}
show(new Base());
show(new Child());
show(new Grandchild());
show(new Inherited());
