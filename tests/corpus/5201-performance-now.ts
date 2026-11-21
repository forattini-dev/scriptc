/// <reference types="node" />
const first = performance.now();
const second = performance.now();
console.log(typeof performance, first >= 0, second >= first);
