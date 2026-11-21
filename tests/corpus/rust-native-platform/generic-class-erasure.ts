class Box<T> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }

  get(): T {
    return this.value;
  }
}

const numberBox = new Box(4);
const stringBox = new Box("value");
console.log(
  numberBox instanceof Box,
  stringBox instanceof Box,
  numberBox.get(),
  stringBox.get(),
);
