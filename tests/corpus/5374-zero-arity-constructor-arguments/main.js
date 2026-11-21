'use strict'

let effects = 0
class InternalOnly {
  constructor () {
    if (arguments[0] !== 'internal') {
      throw new TypeError('Illegal constructor')
    }
  }
}

const value = new InternalOnly((effects++, 'internal'))
console.log(value instanceof InternalOnly, effects)
