type Constructor<T = object> = new (...args: any[]) => T;
let ordinal = 0;
function next() { ordinal++; return ordinal; }
class Base { value = 42; }
function counted<T extends Constructor<object>>(base: T) {
  return class extends base { static ordinal = next(); };
}
const First = counted(Base);
const Second = counted(Base);
console.log(First.ordinal, Second.ordinal, First === Second, ordinal);
First.ordinal = 9;
console.log(First.ordinal, Second.ordinal);
