class Box {
  #value = null;

  constructor(value) {
    this.#value = value;
  }

  read() {
    return this.#value.name;
  }
}

console.log(new Box({ name: 'native' }).read());
