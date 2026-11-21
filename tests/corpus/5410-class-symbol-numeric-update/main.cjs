const kCount = Symbol('count')

class Counter {
  [kCount] = 1

  take() {
    const previous = this[kCount]--
    return [previous, this[kCount]]
  }
}

console.log(new Counter().take().join(','))
