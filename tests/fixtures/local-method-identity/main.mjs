function make() {
  class Box { constructor(value) { this.value=value; } getValue() { return this.value; } }
  return Box;
}
const A=make(), B=make();
const a=new A(1), a2=new A(2), b=new B(3);
const first=a.getValue, sameClass=a2.getValue, otherClass=b.getValue;
console.log(first===sameClass);
console.log(first===otherClass);
first.marker=42;
console.log(sameClass.marker);
console.log(otherClass.marker);
console.log(first.call(b));
console.log(otherClass.call(a));
const bound=first.bind(a);
console.log(bound());
console.log(bound===first);
console.log(a.getValue===first);
console.log(a2.getValue===first);
console.log(b.getValue===otherClass);
first.tag='A'; otherClass.tag='B';
console.log(sameClass.tag);
console.log(otherClass.tag);
console.log(first.bind(a)===bound);
console.log(first.call({value:11}));
try { first.call(null); console.log('unexpected'); } catch (error) { console.log(error instanceof TypeError); }
