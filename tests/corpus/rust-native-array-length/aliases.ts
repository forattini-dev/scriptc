// @rust-only
// @no-engine
// @ts-nocheck
const box: { values: number[] | null } = { values: [1] };
const alias = box;
function clear(): void { alias.values = null; }
if (box.values !== null) {
  clear();
  try { console.log(box.values.length); } catch (e) { if (e instanceof Error) console.log('field', e.name, e.message); else throw e; }
}
const indexed: { values: number[] | undefined } = { values: [2] };
function erase(): void { indexed.values = undefined; }
if (indexed.values !== undefined) {
  erase();
  try { console.log(indexed.values[0]); } catch (e) { if (e instanceof Error) console.log('index', e.name, e.message); else throw e; }
}
const data = [3];
let reads = 0;
function get(): number[] | null { reads++; return data; }
function append(): number { data.push(4); return data.length; }
console.log('order', get().length, append(), reads, get()['length'], reads);
