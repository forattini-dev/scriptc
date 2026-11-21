'use strict'

/** @param {string} value @param {boolean} asObject */
function convert(value, asObject) {
  const before = value
  if (asObject) {
    value = { text: value }
    return before + ':' + value.text
  }
  value = 42
  return before + ':' + value
}

/** @param {number} value */
function replaceNumber(value) {
  value = 'replaced'
  return value
}

console.log(convert('left', true), convert('right', false))
console.log(replaceNumber(3))
