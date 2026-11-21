'use strict';
const target: any = {};
const proxy: any = new Proxy(target, {});
console.log('transparent', Reflect.set(proxy, 'x', 1), target.x);
