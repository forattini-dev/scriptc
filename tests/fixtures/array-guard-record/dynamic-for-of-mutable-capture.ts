let calls = 0;
function* source(): Generator<number, void, undefined> { yield 1; yield 2; }
function make(): any { calls++; return source(); }
const callbacks: Array<() => any> = [];
for (let item of make()) { callbacks.push(() => item); item = Number(item) + 10; }
console.log(calls, callbacks[0](), callbacks[1]());
