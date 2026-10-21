// @rust-only
// @no-engine
class Box {
  #value;
  #count = 1;
  constructor(value) { this.#value = value; }
  get value() { return this.#value; }
  set value(next) { this.#value = next; }
  count() { this.#count = this.#count + 1; return this.#count; }
}
const record = { answer: 42 };
const first = new Box(record);
const second = new Box(record);
console.log("js private", first.value === record, first.value === second.value, first.count() === 2, first.count() === 3, second.count() === 2);
const replacement = { answer: 7 };
console.log("js write", (first.value = replacement) === replacement, first.value.answer === 7, second.value.answer === 42);
