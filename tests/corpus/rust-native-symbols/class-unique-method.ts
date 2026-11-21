// @rust-only
// @no-engine
// @ts-nocheck
import { resourceKey as key, resourceKey as alias, otherKey } from './module-key.ts';
const localAlias = key;
const aliasOfAlias = localAlias;
const iteratorAlias = Symbol.iterator;

class Resource {
  [key](value: string): string { return 'base:' + value; }
  [otherKey](value: string): string { return 'other:' + value; }
}
class Child extends Resource {
  [aliasOfAlias](value: string): string { return super[localAlias](value) + ':child'; }
}
function call(resource: Resource, value: string): string { return resource[key](value); }
const base = new Resource();
const child = new Child();
console.log('keys', key === alias, key === (otherKey as symbol));
console.log('base', base[key]('x'), base[alias]('y'), base[otherKey]('z'));
console.log('override', call(child, 'a'), call(base, 'b'), child[otherKey]('c'));
console.log('local alias', child[localAlias]('q'));
class IterBase { [Symbol.iterator](): number { return 1; } }
class IterChild extends IterBase { [iteratorAlias](): number { return 2; } }
console.log('well-known alias', new IterBase()[iteratorAlias](), new IterChild()[Symbol.iterator]());
class Empty {}
class Added extends Empty { [localAlias](): number { return 3; } }
function hasKey(value: Empty): boolean { return key in value; }
console.log('presence', key in base, aliasOfAlias in child, otherKey in child, key in new Empty());
console.log('subclass presence', hasKey(new Empty()), hasKey(new Added()));
console.log('well-known presence', iteratorAlias in new IterBase(), Symbol.iterator in new IterChild());
