'use strict'

/** @typedef {{ expires?: Date }} Cookie */
/** @param {Cookie} cookie */
function hasValidExpiry(cookie) {
  return !!(cookie.expires && cookie.expires.toString() !== 'Invalid Date')
}

console.log(hasValidExpiry({}))
console.log(hasValidExpiry({ expires: new Date(NaN) }))
console.log(hasValidExpiry({ expires: new Date(0) }))

/** @param {Date | number} value */
function stringify(value) {
  return value.toString()
}
console.log(stringify(42), stringify(new Date(NaN)))
