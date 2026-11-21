/** @param {number} value */
function target(value) {
  return value + 1;
}
/** @param {number} value */
function source(value) {
  return value;
}

const sourceWithProperties = Object.assign(source, { endpoint: "ok" });
const decorated = Object.assign(target, sourceWithProperties);
console.log(decorated.endpoint);
console.log(decorated(4));
console.log(decorated === target);
