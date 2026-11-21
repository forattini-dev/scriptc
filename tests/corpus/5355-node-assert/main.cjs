const assert = require('node:assert')
const strict = require('node:assert/strict')

assert(true)
assert.ok(1, 'unused')
strict.ok('present')
console.log('passed')

try {
  assert(false, 'boom')
} catch (error) {
  console.log(error.name, error.code, error.message)
}

function shadow(assert) {
  return assert('local')
}
console.log(shadow((value) => value.toUpperCase()))
