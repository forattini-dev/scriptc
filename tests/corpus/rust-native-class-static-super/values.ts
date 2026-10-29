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
