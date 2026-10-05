class Base {
  value: number;
  constructor(value: number) { this.value = value; }
}
const configured = function (transform: (value: number) => number) {
  return class extends Base {
    read() { return () => transform(this.value); }
    replace(next: (value: number) => number) { transform = next; }
    static apply(value: number) { return transform(value); }
  };
};
const First = configured(value => value + 1);
const Second = configured(value => value * 2);
const first = new First(7);
const twin = new First(8);
const second = new Second(9);
const read = first.read();
console.log(read(), twin.read()(), second.read()(), First.apply(10), Second.apply(10));
first.replace(value => value + 3);
console.log(read(), twin.read()(), second.read()(), First.apply(10), Second.apply(10));
console.log(First === Second, first instanceof First, second instanceof Second, second instanceof First);
function plain() { return class extends Base { static label() { return "plain"; } }; }
const Plain = plain();
console.log(Plain.label(), new Plain(42).value, Plain.name);
