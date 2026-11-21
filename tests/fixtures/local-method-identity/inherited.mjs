function makeBase() { return class Base { value(){ return 7; } }; }
const Base=makeBase();
class Child extends Base {}
const a=new Base(), b=new Child();
const m=a.value, inherited=b.value;
console.log(m===inherited);
m.marker=8;
console.log(inherited.marker);
console.log(inherited.call(a));
console.log(m.call(b));
console.log(b instanceof Base);
console.log(a instanceof Child);
console.log(b.value===m);
console.log(a.value===inherited);
