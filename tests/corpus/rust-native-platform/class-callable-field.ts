class Processor {
  callback: (n: number) => number;
  constructor(callback: (n: number) => number) { this.callback = callback; }
  run(n: number): number { return this.callback(n); }
}
const p = new Processor((n: number) => n + 2);
console.log("first", p.run(5));
p.callback = (n: number) => n * 3;
console.log("replaced", p.run(5));

class Receiver {
  base: number = 10;
  callback: (this: Receiver, n: number) => number;
  constructor(callback: (this: Receiver, n: number) => number) { this.callback = callback; }
  run(n: number): number { return this.callback(n); }
}
function addBase(this: Receiver, n: number): number { return this.base + n; }
const receiver = new Receiver(addBase);
console.log("receiver", receiver.run(7));

class Missing {
  callback!: (n: number) => number;
  run(): number { return this.callback(sideEffect()); }
  absent(): boolean { return this.callback === undefined; }
}
function sideEffect(): number { console.log("argument effect"); return 1; }
const missing = new Missing();
console.log("absent", missing.absent());
try { missing.run(); } catch (error) { console.log("caught", (error as Error).name, (error as Error).message); }

class Captured {
  value: number = 12;
  callback: () => number;
  constructor() { this.callback = () => this.value; }
  run(): number { return this.callback(); }
}
console.log("captured", new Captured().run());
