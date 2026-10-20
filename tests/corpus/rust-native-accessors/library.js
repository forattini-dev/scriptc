export class Cell {
  _value;
  constructor(value) { this._value = value; }
  get value() { return this._value; }
  set value(next) { this._value = next; }
}
