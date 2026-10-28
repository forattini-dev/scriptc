export {};
class Writable {
  value: number;
  constructor(value: number) { this.value = value; }
  read(): number { return this.value; }
}
const stream = new Writable(9);
function forward(value: Writable): Writable { return value; }
console.log('custom', forward(stream).read(), forward(stream) === stream);
