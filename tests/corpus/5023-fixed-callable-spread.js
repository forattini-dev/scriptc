const target = {
  /** @param {number} left @param {number} right */
  merge(left, right) {
    return left + right;
  },
};
/** @type {[number, number]} */
const args = [2, 3];
console.log(target.merge(...args));
