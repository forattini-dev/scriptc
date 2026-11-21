'use strict'

/** @param {string} origin */
function inspect(origin) {
  if (origin == null || origin === 'null') return 'absent'
  const original = origin
  origin = new URL(origin)
  console.log('url', original, origin.protocol, origin.hostname)
  return origin.href
}

/** @param {string} origin @param {boolean} convert */
function conditional(origin, convert) {
  if (convert) origin = new URL(origin)
  if (convert) return origin.protocol
  return origin
}

console.log('first', inspect('https://example.test/path'))
console.log('absent', inspect('null'))
console.log('conditional', conditional('http://localhost/a', false), conditional('http://localhost/a', true))
try { inspect('not a url') } catch (error) { console.log('invalid', error instanceof TypeError) }
