class Example {
  constructor(shape) {
    this.shape = shape;
  }
}

Example.lazycreate = (shape, params) => new Example({ ...shape, ...params });
const late = { object: Example.lazycreate };
console.log(JSON.stringify(late.object({ a: 1 }, { b: 2 }).shape));
