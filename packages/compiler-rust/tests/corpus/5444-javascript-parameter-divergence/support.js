/**
 * @param {number|null|undefined} value
 */
function describe(value) {
  return typeof value
}

function count(...values) {
  return values.length
}

module.exports = { count, describe }
