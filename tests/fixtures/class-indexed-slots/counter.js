export class Counter {
  constructor(name) {
    this["~name"] = name;
    this["~count"] = 0;
  }
  bump() { this["~count"] = this["~count"] + 1; }
}
