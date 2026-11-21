function hasAsyncIterator (value) {
  return !!value?.[Symbol.asyncIterator]
}

console.log(
  hasAsyncIterator({ [Symbol.asyncIterator]: () => ({}) }),
  hasAsyncIterator({}),
  hasAsyncIterator(null)
)
