/**
 * @param {any} pair
 * @param {number} keyIndex
 * @param {number} valueIndex
 */
function readPair(pair, keyIndex, valueIndex) {
  const { [keyIndex]: key, [valueIndex]: value } = pair
  console.log(key)
  console.log(value)
}

readPair(['left', 'right'], 0, 1)
readPair({ 0: 'zero', 1: 'one' }, 'a'.length - 1, 1)
