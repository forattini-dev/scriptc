// @rust-only
// @no-engine
export {};
class Counter {
  #value = 2;
  #add(value: number = 3): number { this.#value = this.#value + value; return this.#value; }
  #factorial(value: number): number { if (value <= 1) return 1; return value * this.#factorial(value - 1); }
  run(): void { console.log(this.#add(), this.#add(4), this.#factorial(5)); }
}
new Counter().run();
