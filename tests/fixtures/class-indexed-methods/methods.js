export class Base {
  constructor(prefix) { this.prefix = prefix; }
  "~validate"(value) { return this.prefix + value; }
  wrapper() { return { validate: (value) => this["~validate"](value) }; }
}
export class Child extends Base {
  "~validate"(value) { return this.prefix + "child:" + value; }
}
