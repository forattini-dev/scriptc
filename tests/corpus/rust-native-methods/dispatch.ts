// @rust-only
// @no-engine
export {};
class Base {
  constructor() { console.log("construct", this.label()); }
  label(): string { return "base"; }
  describe(n = 1): string { return `base:${n}`; }
  outer(n: number): string { return this.describe(n); }
}
class Child extends Base {
  extra: string | undefined = "ready";
  label(): string { if (this.extra === undefined) return "early"; return this.extra; }
  describe(n = 1): string { return `child:${n}`; }
}
class Grandchild extends Child {
  describe(n = 1): string { return `grand:${super.describe(n)}`; }
}
const base = new Base();
const child = new Child();
const grand = new Grandchild();
function describe(value: Base): void { console.log("dispatch", value.label(), value.describe(), value.outer(4)); }
describe(base);
describe(child);
describe(grand);
const alias: Base = grand;
console.log("identity", alias === grand, alias instanceof Base, alias instanceof Child);
