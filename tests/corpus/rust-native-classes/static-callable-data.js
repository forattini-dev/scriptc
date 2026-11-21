class Example {
  constructor(value) {
    this.value = value;
  }

  static assert(value) {
    return value instanceof Example;
  }
}

Example.create = (value) => new Example(value);
const create = Example.create;
const example = create(42);
console.log(Example.assert(example), example.value, Example.create === create);
console.log(Example.create(9).value);
