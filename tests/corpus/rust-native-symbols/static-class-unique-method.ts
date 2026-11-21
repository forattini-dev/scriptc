const key = Symbol('static-method');

class Counter {
  [key](): number {
    return 1;
  }

  static [key](value: number): number {
    return value + 5;
  }
}

const read = Counter[key];
console.log(read(4), Counter[key](7), new Counter()[key]());
