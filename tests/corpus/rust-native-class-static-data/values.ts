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
