let calls = 0;
function* source(): Generator<number, void, undefined> { yield 1; yield 2; }
function make(): any { calls++; return source(); }
const callbacks: Array<() => any> = [];
for (const item of make()) callbacks.push(() => item);
console.log(calls, callbacks[0](), callbacks[1]());
