class Base { read() { return this.constructor.name; } }
class Shadow extends Base { static name = 12; }
console.log(new Shadow().read());
