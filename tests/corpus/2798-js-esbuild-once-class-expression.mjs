let factoryRuns = 0;

const once = (factory, value) => () =>
  (factory && (value = factory(factory = 0)), value);

const initialize = once(() => {
  factoryRuns++;
  const LocalCounter = class {
    value() {
      return 5;
    }
  };
  const counter = new LocalCounter();
  console.log(counter.value());
  return counter.value();
});

const first = initialize();
const second = initialize();

console.log(factoryRuns, first === second, first);
