// @rust-only
// @no-engine
// @ts-nocheck
class Circle { radius: number; constructor(n: number) { this.radius = n; } }
class Square { side: number; constructor(n: number, step: number = 1) { this.side = n + step; } }
function create(kind: typeof Circle | typeof Square, value: number): any {
  return new kind(value);
}
const circle: any = create(Circle, 7);
const square: any = create(Square, 8);
console.log('brands', circle instanceof Circle, circle instanceof Square,
  square instanceof Circle, square instanceof Square);
console.log('values', circle.radius === 7, square.side === 9);
const alias: any = circle;
alias.radius = 9;
console.log('identity', alias === circle, circle.radius === 9);
function observeCircle(value: Circle): number { return value.radius; }
console.log('typed-view', observeCircle(circle));
const key = 'side';
square[key] = 10;
console.log('computed', square.side === 10);
class Config { static Group: typeof Circle | typeof Square = Circle; }
function fromConfig(value: number): any { return new Config.Group(value); }
console.log('static-a', fromConfig(4).radius === 4);
Config.Group = Square;
console.log('static-b', fromConfig(5).side === 6);
let effects = '';
function extra(): number { effects += 'e'; return 3; }
function withExtra(kind: typeof Circle | typeof Square): any { return new kind(10, extra()); }
console.log('extra', withExtra(Circle).radius === 10, withExtra(Square).side === 13, effects);
class Parent { value = 1; label = 'old'; note: string | undefined; }
class Child extends Parent { extra = 2; }
const child: any = new Child();
child.value = 3;
child.extra = 4;
child.label = 'new';
child.note = 'present';
function observeParent(value: Parent): number { return value.value; }
console.log('inherited-fields', observeParent(child), child.extra === 4,
  child.label === 'new', child.note === 'present');
child.note = undefined;
console.log('undefined-field', child.note === undefined);
class Link { next: Link | undefined; }
const link: any = new Link();
link.next = link;
console.log('cycle', link.next === link);
