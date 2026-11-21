async function* values(): AsyncGenerator<number, void, unknown> {
  yield 1;
}

const iterator = values();
const sameIterator = iterator[Symbol.asyncIterator]();
sameIterator.next();
console.log(true);

const iterable = {
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: true }),
  }),
};
const objectIterator = iterable[Symbol.asyncIterator]();
console.log(typeof objectIterator.next === "function");
