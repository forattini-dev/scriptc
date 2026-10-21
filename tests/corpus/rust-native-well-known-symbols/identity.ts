// @rust-only
// @no-engine
export {};
function same(a: symbol, b: symbol): boolean { return a === b; }
const symbols: symbol[] = [
  Symbol.asyncIterator,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable,
  Symbol.iterator,
  Symbol.match,
  Symbol.matchAll,
  Symbol.replace,
  Symbol.search,
  Symbol.species,
  Symbol.split,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.unscopables,
  Symbol.dispose,
  Symbol.asyncDispose,
];
const again: symbol[] = [
  Symbol.asyncIterator,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable,
  Symbol.iterator,
  Symbol.match,
  Symbol.matchAll,
  Symbol.replace,
  Symbol.search,
  Symbol.species,
  Symbol.split,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.unscopables,
  Symbol.dispose,
  Symbol.asyncDispose,
];
symbols.map((value, i) => {
  const description = value.description;
  console.log('identity', value.toString(), description === again[i].description, Symbol.keyFor(value) === undefined, same(value, again[i]));
  if (description !== undefined) {
    console.log('separate', same(value, Symbol.for(description)), same(value, Symbol(description)));
  }
  symbols.map((other, j) => {
    if (j < i) console.log('distinct', i, j, same(value, other));
    return false;
  });
  return true;
});
// Preserve the original formerly refused direct read, including its textual value.
const iterator = Symbol.iterator;
console.log(iterator.toString());
