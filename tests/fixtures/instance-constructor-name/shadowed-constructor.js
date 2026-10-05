class Base { read() { return this.constructor.name; } }
class Shadow extends Base { ["constructor"]() {} }
const value = new Shadow();
console.log(value.read());
