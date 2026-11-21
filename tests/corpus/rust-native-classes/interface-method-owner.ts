interface CounterLike {
  next(delta: number): number;
}

class Counter {
  value = 7;

  next(delta: number): number {
    this.value += delta;
    return this.value;
  }
}

function advance(counter: CounterLike): number {
  return counter.next(3);
}

const counter = new Counter();
console.log(advance(counter), counter.value, advance(counter));
