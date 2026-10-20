// @rust-only
// @no-engine
export {};
class Signal {
  _value = 1;
  reads = 0;
  writes = 0;
  get value(): number { this.reads = this.reads + 1; return this._value; }
  set value(value: number) { this.writes = this.writes + 1; this._value = value; }
  update(value: number): void { this.value = value; }
  get unused(): number { while (true) {} }
}
const signal = new Signal();
const alias = signal;
console.log("initial", signal.value, alias.value, signal.reads);
console.log("assignment", (alias.value = 7), signal.writes, signal.reads);
signal.update(9);
console.log("updated", signal.value, signal.writes, signal.reads, alias === signal);
class Fault extends Error { get field(): number { return 1; } }
console.log("error accessor", new Fault("message").field);
class Box { get value() { return 1; } }
console.log("getter only", new Box().value);
class Optional {
  stored: number | undefined;
  get value(): number | undefined { return this.stored; }
  set value(value: number | undefined) { this.stored = value; }
}
const optional = new Optional();
console.log("optional", optional.value === undefined, (optional.value = 4), optional.value === 4);
console.log("assignment type", (optional.value = 5) + 1);
optional.value = undefined;
console.log("cleared", optional.value === undefined);

class Ordinary { get value() { return 1; } } try { throw new Ordinary(); } catch {}
