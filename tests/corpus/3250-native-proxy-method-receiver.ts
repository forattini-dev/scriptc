// @rust-only
// @no-engine
type Reader = { value: number; read: (add: number) => number };
const target = {
  value: 7,
  read: function(this: { value: number }, add: number): number { return this.value + add; },
};
const typed: Reader = new Proxy(target, {});
console.log('typed', typed.read(1));
const computed: any = typed;
const readKey = 'read';
console.log('computed', computed[readKey](2));
console.log('nested', new Proxy(typed, {}).read(3));

let expected: unknown;
const identify = function(this: unknown): boolean { return this === expected; };
const trap = new Proxy({}, { get: (_target, _key) => identify });
expected = trap;
console.log('trap-receiver', (trap as { identify: () => boolean }).identify());
const outer = new Proxy(trap, {});
expected = outer;
console.log('outer-receiver', (outer as { identify: () => boolean }).identify());
const extracted = (outer as { identify: () => boolean }).identify;
expected = undefined;
console.log('extracted', extracted());
const raw: any = trap;
const dynamicExtracted = raw.identify;
console.log('dynamic-extracted', dynamicExtracted());

let events = '';
const ordered = new Proxy(target, {
  get(object, key) {
    events += 'get:' + String(key) + ';';
    if (key === 'read') return object.read;
    return object.value;
  },
});
function receiver(): any { events += 'receiver;'; return ordered; }
function key(): string { events += 'key;'; return 'read'; }
function arg(): number { events += 'arg;'; return 4; }
console.log('order', receiver()[key()](arg()), events);
events = '';
function typedReceiver(): Reader { events += 'receiver;'; return ordered; }
console.log('typed-order', typedReceiver().read(arg()), events);

const ordinary = {
  value: 10,
  read: function(this: { value: number }): number { this.value++; return this.value; },
};
console.log('ordinary-live', ordinary.read(), ordinary.value, ordinary.read(), ordinary.value);

const unbound = function(this: unknown): boolean { return this === undefined; };
function directUnbound(this: unknown): boolean { return this === undefined; }
const nestedCalls = {
  check: function(this: unknown): boolean { return unbound(); },
  direct: function(this: unknown): boolean { return directUnbound(); },
};
console.log('nested-unbound', nestedCalls.check(), nestedCalls.direct());
export {};
