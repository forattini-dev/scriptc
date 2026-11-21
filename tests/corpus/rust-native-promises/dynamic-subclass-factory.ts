class Base {
  value: string;
  constructor(value: string) { this.value = value; }
}
function factory(prefix: string) {
  return class extends Base {
    static label = prefix;
    read: () => string;
    constructor(value: string) {
      super(prefix + value);
      this.read = () => this.decorate();
    }
    decorate(): string { return this.value + "!"; }
  };
}
const First = factory("a");
const Second = factory("a");
console.log(First === Second);
console.log(First.label);
console.log(Second.label);
console.log(new First("x").value);
console.log(new First("x").read());
