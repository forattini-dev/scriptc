class Counter {
  #value = 3;

  get #next(): number {
    this.#value = this.#value + 1;
    return this.#value;
  }

  read(): number {
    return this.#next;
  }
}

const counter = new Counter();
console.log(counter.read(), counter.read());
