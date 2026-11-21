// @rust-only
// @no-engine
class Parent { static identity() { return this; } }
class Child extends Parent {}
class Grandchild extends Child {}
console.log('parent', Parent.identity() === Parent, Parent.identity() === Child);
console.log('child', Child.identity() === Child, Child.identity() === Parent);
console.log('grandchild', Grandchild.identity() === Grandchild, Grandchild.identity() === Child);
console.log('construct', new (Child.identity())() instanceof Child);
class Named {
  static list(prefix: string, ...items: string[]): string {
    return (this === Named ? prefix : 'child') + ':' + items.join(',');
  }
}
class NamedChild extends Named {}
console.log('rest', Named.list('base'), Named.list('base', 'one', 'two'));
console.log('inherited rest', NamedChild.list('ignored', 'x', 'y'));
let order = '';
function mark(value: string): string { order += value; return value; }
console.log('rest evaluation', Named.list(mark('a'), mark('b'), mark('c')), order);
class Utility {
  static count(...numbers: number[]): number { numbers.push(9); return numbers.length; }
}
console.log('fresh rest', Utility.count(1, 2), Utility.count());
class Factory {
  static identity() { return this; }
  constructor() { console.log('base constructor'); }
}
class FactoryChild extends Factory {
  constructor() { super(); console.log('child constructor'); }
}
new (FactoryChild.identity())();
