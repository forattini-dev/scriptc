// @rust-only
// @no-engine
let calls = 0;
const node = { index: 0, keys: ['a', 'b', 'c'] };
const alias = node;
function receiver(): { index: number; keys: string[] } { calls++; return node; }
console.log('receiver', receiver().index++, calls, alias.index);
console.log('prefix', ++receiver()['index'], calls, alias.index);
node.index = 0;
console.log('key', node.keys[node.index++], node.keys[++node.index], node.index);
const nested = { inner: node };
console.log('nested', nested.inner.index--, node.index);
let count = 0;
while (node.index-- > 0) { count++; }
console.log('loop', count, node.index);
const values = [10, 20];
let index = 0;
console.log('order', values[index++], index, values[index++], index);
