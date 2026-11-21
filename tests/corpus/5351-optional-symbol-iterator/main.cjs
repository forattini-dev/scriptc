/**
 * @param {any} value
 * @param {any} [Iterable]
 */
function consume (value, Iterable) {
  /** @type {Generator} */
  const method = typeof Iterable === 'function' ? Iterable() : value?.[Symbol.iterator]?.()
  if (method === undefined) {
    return 'missing'
  }
  const output = []
  while (true) {
    const { done, value: item } = method.next()
    if (done) {
      break
    }
    output.push(item)
  }
  return output.join('|')
}

const source = [1, 'two', 3]
console.log(consume(source))
console.log(source.join(','))
console.log(consume(null))

const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([4, 5][Symbol.iterator]()))
console.log(iteratorPrototype !== null)
const custom = {}
Object.setPrototypeOf(custom, iteratorPrototype)
console.log(Object.getPrototypeOf(custom) === iteratorPrototype)
