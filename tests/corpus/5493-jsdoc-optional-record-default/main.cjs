/**
 * @typedef {Object} MatchOptions
 * @property {boolean} [caseSensitive=false]
 * @property {boolean} [matchBody=true]
 * @property {string[]} [ignoreHeaders=[]]
 */

/** @param {MatchOptions} [options] */
function describe(options = {}) {
  const { caseSensitive = false } = options
  const count = options.ignoreHeaders === undefined ? 0 : options.ignoreHeaders.length
  return `${caseSensitive}:${options.matchBody !== false}:${count}`
}

console.log(describe())
console.log(describe({ caseSensitive: true, matchBody: false, ignoreHeaders: ['x'] }))
