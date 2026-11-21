let events = '';
let value = 1;
const object: any = {};
Object.defineProperty(object, 'value', {
  get() { events += 'g'; return value; },
  set(next: number) { events += 's'; value = next; },
  configurable: true,
});
function receiver(): any { events += 'o'; return object; }
function key(): string { events += 'k'; return 'value'; }
function right(): number { events += 'r'; value = 100; return 3; }
const result = receiver()[key()] += right();
console.log('order', events, 'result', result, 'value', value);

object.count = 12;
object.count *= 2;
object.count -= 3;
object.count >>= 1;
object.label = 'v';
object.label += 7;
object.big = 2n;
object.big += 3n;
console.log('values', object.count, object.label, object.big);

const token = Symbol('counter');
object[token] = 6;
console.log('symbol', object[token] += 4, object[token]);

events = '';
function bigintRight(): bigint { events += 'r'; return 1n; }
try {
  receiver().value += bigintRight();
} catch (error) {
  console.log('mixed', error instanceof TypeError, events, value);
}
