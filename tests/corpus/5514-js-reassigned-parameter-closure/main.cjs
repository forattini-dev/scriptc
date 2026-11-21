'use strict'

/** @param {string} value */
function captured(value) {
  const get = () => value
  const original = get()
  value = { text: value }
  return original + ':' + get().text
}

/** @param {string} value */
function capturedBlock(value) {
  const get = function () { return value }
  value = { text: value }
  return get().text
}

console.log(captured('closure'))
console.log(capturedBlock('block'))
