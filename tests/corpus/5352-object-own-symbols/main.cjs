const first = Symbol('first')
const second = Symbol.for('second')
const object = {
  plain: 1,
  [first]: 2,
  [second]: 3
}

const symbols = Object.getOwnPropertySymbols(object)
console.log(symbols.length)
console.log(symbols[0] === first)
console.log(symbols[1] === second)

const combined = [...Object.getOwnPropertyNames(object), ...Object.getOwnPropertySymbols(object)]
console.log(combined.length)
console.log(combined[1] === first)
console.log(combined[2] === second)

const descriptor = Reflect.getOwnPropertyDescriptor(object, first)
console.log(descriptor.value)
console.log(descriptor.enumerable)

let enumerable = 0
for (const key of Reflect.ownKeys(object)) {
  const current = Reflect.getOwnPropertyDescriptor(object, key)
  if (current?.enumerable) {
    enumerable++
  }
}
console.log(enumerable)
