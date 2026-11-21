export class Signal {
  _value;

  constructor(initialValue) {
    this._value = initialValue;
  }

  get value() {
    return this._value;
  }

  set value(next) {
    this._value = next;
  }
}

export function createSignal(initialValue) {
  const signal = new Signal(initialValue);
  const getter = () => signal.value;
  const setter = (value) => {
    signal.value = value;
  };
  return [getter, setter];
}
