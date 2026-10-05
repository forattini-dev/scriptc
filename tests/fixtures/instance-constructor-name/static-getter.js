class Base { read() { return this.constructor.name; } }
class Shadow extends Base { static get name() { return "shadow"; } }
console.log(new Shadow().read());
