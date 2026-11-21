function* source(): Generator<number, void, undefined> { yield 1; yield 2; }
const callbacks: Array<() => number> = [];
for (let item of source()) { callbacks.push(() => item); item += 10; }
console.log(callbacks[0](), callbacks[1]());
