// @rust-only
// @no-engine
// @ts-nocheck
class Base { static count = 3; }
class Child extends Base {
  static count = 7;
  static inherited = super.count;
  static own = this.count;
}
console.log('shadow', Child.inherited, Child.own, Base.count);
const alias = Base;
alias.count = 12;
class Middle extends Base {}
class Later extends Middle { static inherited = super.count; }
console.log('live', Later.inherited, Base.count);
function change(): number { Base.count = 20; return 1; }
class Binary extends Base {
  static before = super.count + change();
  static after = change() + super.count;
}
console.log('binary', Binary.before, Binary.after, Base.count);
let calls = 0;
function touch(): number { calls++; return 99; }
class ShortCircuit extends Base {
  static or = super.count || touch();
  static and = 0 && super.count;
}
console.log('short', ShortCircuit.or, ShortCircuit.and, calls);
