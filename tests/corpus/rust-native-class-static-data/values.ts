// @rust-only
// @no-engine
let log = '';
function mark(value: number): number { log += String(value); return value; }
class Group { value = 7; }
class Box {
  static first = mark(1);
  static second = mark(2);
  static empty: number | undefined;
  static Group = Group;
}
class Child extends Box { static third = mark(3); }
console.log('order', log, Box.first, Box.second, Child.third);
console.log('empty', Box.empty === undefined, Object.hasOwn(Box as any, 'empty'));
console.log('class', (Box as any).Group === Group);
Box.first = 8;
console.log('mutation', Box.first, Child.first);
Child.first = 9;
console.log('shadow', Box.first, Child.first);
function beforeBinding(): string {
  try { return typeof Guard; } catch { return 'tdz'; }
}
class Guard { static observation = beforeBinding(); }
console.log('binding', Guard.observation);
class SelfRef {
  static first = 11;
  static next = SelfRef.first + 1;
  static self = SelfRef;
  static receiver = this;
  static fromReceiver = this.next + 1;
  static getSelf = () => SelfRef;
}
console.log('self', SelfRef.next, (SelfRef as any).self === SelfRef);
console.log('receiver', (SelfRef as any).receiver === SelfRef, SelfRef.fromReceiver);
console.log('closure', (SelfRef as any).getSelf() === SelfRef);
class Forward {
  static missing = (Forward as any).later === undefined;
  static later = 5;
}
console.log('forward', Forward.missing, Forward.later);
class DerivedSelf extends SelfRef { static receiver = this; }
console.log('derived-this', (DerivedSelf as any).receiver === DerivedSelf, (SelfRef as any).receiver === SelfRef);
