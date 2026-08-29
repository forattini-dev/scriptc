class WrappedValue {
  readonly label: string;
  readonly value: unknown;

  constructor(label: string, value: unknown) {
    this.label = label;
    this.value = value;
  }

  numberValue(): number {
    return this.value as number;
  }
}

const wrapped = new WrappedValue("answer", 42);
console.log(wrapped.label, wrapped.numberValue());
