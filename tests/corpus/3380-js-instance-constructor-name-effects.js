// @no-engine
class Base {
  constructor() { this.seen = this.constructor.name; }
  read() { return this.constructor.name; }
}
class Renamed extends Base { static name = "first"; }
class Leaf extends Renamed {}
let reads = 0;
function source() { reads++; return new Renamed(); }
console.log(source().constructor.name, reads);
const value = new Renamed();
console.log(value.seen, value.read());
Renamed.name = "second";
console.log(value.read(), new Renamed().seen, new Leaf().read());
