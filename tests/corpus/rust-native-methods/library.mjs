export class Calculator {
  constructor(value) { this.value = value; }
  add(step = 1) { this.value = this.value + step; return this.value; }
  clear() { this.value = 0; }
}
export class Box {
  constructor(value) { this.value = value; }
  get() { return this.value; }
  set(value) { this.value = value; }
}
