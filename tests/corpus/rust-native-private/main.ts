// @rust-only
// @no-engine
export {};
class Box {
  #value = 1;
  read(): number { return this.#value; }
}
const first = new Box();
console.log("private field", first.read(), new Box().read());
