class Counter {
  #count = 0;
  value() { return this.#count; }
}
const counter = new Counter();
Object.assign(counter, { "#count": 7 });
console.log(counter.value());
