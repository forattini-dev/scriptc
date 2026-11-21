// @rust-only
// @no-engine
const values = ['one', 'two'];
let events = '';
function source(): string[] { events += 's'; return values; }
function change(): string { events += 'm'; values.push('three'); return 'middle'; }
function gather(prefix: string, ...items: string[]): string { return prefix + ':' + items.join(','); }
console.log('function', gather('start', ...source(), change(), ...source()), events);
class Collector {
  static gather(prefix: string, ...items: string[]): string {
    return (this === Collector ? prefix : 'derived') + ':' + items.join(',');
  }
}
class Child extends Collector {}
console.log('static', Child.gather('ignored', 'x', ...values, ...'😀a'));
console.log('empty', gather('nothing', ...[]));
const numbers = [12, 34];
console.log('coercion', String(...numbers), Number(...numbers));
console.log('no args', String(...[]), Number(...[]));
const names = new Map<string, number>([['left', 1], ['right', 2]]);
console.log('map keys', gather('keys', ...names.keys()));
const alias = gather;
console.log('alias', alias('alias', ...values));
const unique = new Set<string>(['u', 'v', 'u']);
console.log('set', gather('set', ...unique));
