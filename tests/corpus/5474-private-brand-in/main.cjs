class BrandedIterator {
  #target

  /** @param {object} target */
  constructor(target) {
    this.#target = target
  }

  /** @param {object} value */
  hasBrand(value) {
    return #target in value
  }
}

const branded = new BrandedIterator([])
const other = {}
console.log(branded.hasBrand(branded))
console.log(branded.hasBrand(other))
