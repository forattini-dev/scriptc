// @rust-only
// @no-engine
// @transform-types
namespace Shapes {
  export interface Ready<T> { value: T; read(): T; }
  export class Base {
    value = 7;
    read(): number { return this.value; }
  }
}
interface Child extends Shapes.Ready<number> { label: string; }
class Derived extends Shapes.Base implements Child {
  label = "derived";
  read(): number { return super.read() + 1; }
}
class OnlyImplements implements Shapes.Ready<number> {
  value = 3;
  read(): number { return this.value * 2; }
}
const Selected = class extends Shapes.Base {
  read(): number { return super.read() * 2; }
};
const derived = new Derived();
console.log(derived.label, derived.value, derived.read(), derived instanceof Shapes.Base);
console.log(new OnlyImplements().read(), new Selected().read());
derived.value = 20;
console.log(derived.read());
