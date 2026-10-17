/** @param {number} value */
function inverse(value) { return 1 / value; }
const numbers = require('./numeric.json');
console.log("numbers", numbers.round === 9888899923483823.8, numbers.big === 1/0, inverse(numbers.tiny) === -1/0, inverse(numbers.zero) === -1/0, numbers.subnormal === 5e-324);
const bom = require('./bom.json');
console.log("bom", bom.value === "ready");
