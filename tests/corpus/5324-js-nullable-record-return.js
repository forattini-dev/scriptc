export {};

/** @param {number} value */
function normalize(value) {
  if (value < 0) {
    return null;
  }
  return { x: value };
}

const normalized = [-1, 2]
  .map((value) => normalize(value))
  .filter((value) => value !== null);

console.log(normalized.length, normalized[0].x);
