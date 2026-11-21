class Example {
  constructor(value) {
    this.value = value;
  }

  static create(value) {
    return new Example(value);
  }
}

const factory = Example.create;
console.log(factory(42).value, factory === Example.create);
