// @rust-only
// @no-engine
class Parent {}
class Child extends Parent {}
class Other {}
const parent: any = Parent;
const alias: any = Parent;
const child: any = Child;
const other: any = Other;
parent.label = 'first';
console.log('alias', alias.label === 'first', other.label === undefined);
alias.label = 'second';
console.log('inherited', parent.label === 'second', child.label === 'second');
child.label = 'child';
console.log('shadow', parent.label === 'second', child.label === 'child');
parent.empty = undefined;
console.log('undefined', parent.empty === undefined, child.empty === undefined);
console.log('presence', 'empty' in child, Object.hasOwn(parent, 'empty'), Object.hasOwn(child, 'empty'));
console.log('keys', Object.keys(parent).join(','), Object.keys(child).join(','));
parent.self = parent;
console.log('identity', alias.self === parent, child.self === parent);
const payload = { value: 3 };
parent.payload = payload;
console.log('object', alias.payload === payload, child.payload === payload);
const key = 'label';
console.log('computed', child[key] === 'child');
parent.Group = Child;
console.log('constructor', alias.Group === Child, child.Group === Child);
alias.Group = Other;
console.log('replacement', parent.Group === Other, child.Group === Other);
