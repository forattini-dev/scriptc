const object = { *[Symbol.iterator]() { yield 1; yield 2; } };
const iterator = object[Symbol.iterator]();
console.log(JSON.stringify(iterator.next()), JSON.stringify(iterator.next()), JSON.stringify(iterator.next()));
