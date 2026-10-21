// @rust-only
// @no-engine
export {};
class Box {
  #value = 3;
  #read() { return this.#value; }
  value() { return this.#read(); }
}
const Anonymous = class {
  #read() { return 4; }
  call(value) { return value.#read(); }
};
console.log(new Box().value());
const value = new Anonymous();
console.log(value.call(value) === 4);
try { value.call({}); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
try { value.call(null); } catch (error) { if (error instanceof TypeError) console.log(error.message); }
