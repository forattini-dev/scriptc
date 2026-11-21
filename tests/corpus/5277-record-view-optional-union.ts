interface ConcreteState {
  value(): number;
  set(value: number): void;
  reset(): void;
}

interface StateView {
  value(): number;
  set(value: number): void;
}

interface Options {
  state?: StateView;
}

let current = 4;
const state: ConcreteState = {
  value: () => current,
  set: (value) => {
    current = value;
  },
  reset: () => {
    current = 0;
  },
};

function render(options: Options): void {
  if (options.state) console.log(options.state.value());
}

render({ state });
