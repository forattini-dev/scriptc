function* source(): Generator<number, void, undefined> { yield 1; yield 2; }
function make(): any { return source(); }
const callbacks: Array<() => any> = [];
for (var item of make()) callbacks.push(() => item);
console.log(callbacks[0](), callbacks[1]());
