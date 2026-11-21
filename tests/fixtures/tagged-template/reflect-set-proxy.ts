'use strict';
const target: any = {};
let calls = 0;
const proxy: any = new Proxy(target, {
  set(_target: any, _key: string | symbol, _value: any): boolean {
    calls++;
    return false;
  },
});
console.log('result', Reflect.set(proxy, 'x', 1), Object.hasOwn(target, 'x'), calls);
