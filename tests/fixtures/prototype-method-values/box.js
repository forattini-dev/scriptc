export class Box {
  constructor(value) { this.value = value; this.alias = this.read; }
  read() { return this.value; }
  write(value) { this.value = value; return this; }
  invoke(suffix) { return this.read() + suffix; }
}
export class Child extends Box {}
export class Override extends Box { read() { return 'override:' + this.value; } }
