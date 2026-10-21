// @rust-only
// @no-engine
import { iterator, asyncIterator } from './dependency.ts';
function same(a: symbol, b: symbol): boolean { return a === b; }
console.log('modules', same(iterator, Symbol.iterator), same(asyncIterator(), Symbol.asyncIterator));
const identity = { iterator: Symbol.iterator };
console.log('field', same(identity.iterator, iterator));
