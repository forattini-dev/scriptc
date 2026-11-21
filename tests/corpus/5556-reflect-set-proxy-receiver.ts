'use strict';
const target: any = {};
const events: string[] = [];
const handler: any = {};
Object.defineProperty(handler, 'getOwnPropertyDescriptor', {
  get() { events.push('descriptor'); return undefined; }, configurable: true,
});
Object.defineProperty(handler, 'defineProperty', {
  get() { events.push('define'); return undefined; }, configurable: true,
});
const proxy: any = new Proxy(target, handler);
console.log('transparent', Reflect.set(proxy, 'x', 1), target.x, events.join(','));

const receiverTarget: any = {};
let setCalls = 0;
const receiver: any = new Proxy(receiverTarget, {
  set() { setCalls++; return false; },
});
console.log('receiver', Reflect.set({}, 'y', 2, receiver), receiverTarget.y, setCalls);
Object.defineProperty(receiverTarget, 'locked', { value: 3, writable: false, configurable: true });
console.log('locked', Reflect.set({}, 'locked', 4, receiver), receiverTarget.locked, setCalls);
const symbol = Symbol('key');
console.log('symbol', Reflect.set({}, symbol, 5, receiver), receiverTarget[symbol], setCalls);
