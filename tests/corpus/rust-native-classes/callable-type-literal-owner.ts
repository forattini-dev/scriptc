type MetricSource = {
  lastResponseMetrics: () => number | undefined;
};

class Counter {
  value = 7;

  lastResponseMetrics(): number {
    this.value += 3;
    return this.value;
  }
}

function read(source: MetricSource): number | undefined {
  return source.lastResponseMetrics();
}

const counter = new Counter();
console.log(read(counter), counter.value, read(counter));
