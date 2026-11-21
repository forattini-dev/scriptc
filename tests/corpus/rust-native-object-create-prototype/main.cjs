'use strict'

const { pinoErrProto } = require('./err-proto.cjs')

function errSerializer (err) {
  const _err = Object.create(pinoErrProto)
  _err.type = err.constructor.name
  _err.message = err.message
  _err.raw = err
  return _err
}

const serialized = errSerializer(new TypeError('bad input'))
console.log(serialized.type, serialized.message, serialized.raw instanceof TypeError)
console.log(JSON.stringify(serialized), Object.keys(serialized).join(','))
console.log(Object.getPrototypeOf(serialized) === pinoErrProto, 'raw' in serialized, Object.hasOwn(serialized, 'raw'))
const base = { greet () { return 'hi ' + this.name } }
const child = Object.create(base)
child.name = 'ada'
console.log(child.greet(), Object.getPrototypeOf(child) === base)
try { Object.create(42) } catch (error) { console.log(error instanceof TypeError) }
