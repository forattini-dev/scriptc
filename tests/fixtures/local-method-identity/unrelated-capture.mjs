function make(seed) {
  return class Box { constructor() { this.value=seed; } getValue() { return this.value; } };
}
const A=make(1), B=make(2);
const a=new A(), b=new B();
const x=a.getValue, y=b.getValue;
console.log(x===y);
console.log(x.call(a));
console.log(y.call(b));
console.log(x.call(b));
