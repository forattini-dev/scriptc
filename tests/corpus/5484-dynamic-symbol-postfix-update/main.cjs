const index = Symbol('index')

class Counter {
  constructor() {
    this[index] = 4
  }
}

function bump(value) {
  return value[index]++
}

const counter = new Counter()
console.log(bump(counter))
console.log(counter[index])
