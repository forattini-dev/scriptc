/** @param {string} value */
function matches(value) {
  return pattern.test(value);
}

var pattern = /ready/;
console.log(matches('ready'), matches('waiting'));
