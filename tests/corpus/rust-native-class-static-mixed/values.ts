// @rust-only
// @no-engine
class Base {
  static count = 2;
  static double(value: number): number { return value * 2; }
  static current(): number { return Base.count; }
}
class Child extends Base { static extra = 4; }
console.log('initial', Base.count, Base.double(3), Child.extra, Child.double(4));
Base.count = 5;
console.log('live', Base.current(), Child.count, Child.current());
Child.count = 8;
console.log('shadow', Base.count, Child.count, Base.current());
const alias = Base;
alias.count = 11;
console.log('alias', Base.current(), Child.count);
