// @rust-only
// @no-engine
export {};
function shadow(Symbol: { iterator: number; asyncIterator: string }): string {
  console.log('local', Symbol.iterator);
  return Symbol.asyncIterator;
}
console.log(shadow({ iterator: 7, asyncIterator: 'local' }));
const Symbol = { iterator: 9, asyncIterator: 'module' };
console.log('module', Symbol.iterator, Symbol.asyncIterator);
