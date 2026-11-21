export class Base {
  constructor(value) {
    this.value = value;
  }

  read() {
    return this.value + "!";
  }

  set(value) {
    this.value = value;
  }
}
