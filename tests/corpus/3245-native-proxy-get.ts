// @rust-only
// @no-engine
let calls = 0;
let observedReceiver: unknown;
const token = Symbol('token');
const target = { value: 7 };
const handler = {
  get(value: { value: number }, key: string | symbol, receiver: unknown): unknown {
    calls++;
    observedReceiver = receiver;
    if (typeof key === 'symbol') return key === token ? token : undefined;
    if (key === 'value') return value.value;
    if (key === 'self') return receiver;
    return undefined;
  },
};
const proxy = new Proxy(target, handler);
const view = proxy as unknown as { value: number; self: unknown; missing?: number };
console.log('lazy', calls);
console.log('read', view.value, calls, observedReceiver === proxy);
console.log('self', view.self === proxy, calls);
target.value = 9;
console.log('live', view.value, calls);
const dynamic: any = proxy;
console.log('symbol', dynamic[token] === token, dynamic[Symbol('other')] === undefined);
console.log('kind', typeof dynamic, dynamic !== target, dynamic === proxy);
const outer = new Proxy(proxy, {});
console.log('nested', outer.value, observedReceiver === outer);
const pass = new Proxy(target, {});
console.log('fallback', pass.value);
console.log('missing', view.missing === undefined);
handler.get = (value, key, receiver) => {
  calls++;
  observedReceiver = receiver;
  return value.value + 2;
};
console.log('changed-handler', view.value, calls, observedReceiver === proxy);
const receiverHandler = { marker: 'handler', get: function(this: { marker: string }, object: {}, key: string | symbol): unknown { return this.marker; } };
const withThis = new Proxy({}, receiverHandler);
console.log('handler-this', (withThis as unknown as { value: unknown }).value);

const failure = new Error('trap failed');
const throwing = new Proxy({}, { get() { throw failure; } });
try { const invalid = (throwing as unknown as { value: unknown }).value; console.log('unexpected-trap', invalid); }
catch (error) { console.log('trap-throws', error instanceof Error && error === failure); }

function cycle(): void {
  const owned = { back: undefined as unknown, value: 3 };
  const wrapped = new Proxy(owned, { get(object, key) { return typeof key === 'string' && key === 'value' ? object.value : object.back; } });
  owned.back = wrapped;
  console.log('cycle', wrapped.value);
}
cycle();

let keyCalls = 0;
function key(): symbol { keyCalls++; return token; }
function optional(value: unknown): unknown { const dynamic: any = value; return dynamic?.[key()]; }
console.log('optional-miss', optional(null), optional(undefined), keyCalls);
console.log('optional-hit', optional(proxy) === 11, keyCalls);
