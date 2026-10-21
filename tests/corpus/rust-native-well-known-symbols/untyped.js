// @rust-only
// @no-engine
export {};
const value = Symbol.asyncIterator;
const record = { key: value };
function get() { return Symbol.asyncIterator; }
console.log(value === get(), record.key === value, value.description === 'Symbol.asyncIterator', value.toString());
console.log(Symbol.keyFor(value) === undefined, Symbol.for('Symbol.asyncIterator') === value);
