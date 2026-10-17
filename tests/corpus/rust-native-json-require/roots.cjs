/** @param {number} value */
function inverse(value) { return 1 / value; }
const zero = require('./zero.json');
const large = require('./number.json');
const boolean = require('./bool.json');
const nil = require('./null.json');
const text = require('./string.json');
const array = require('./array.json');
const same = require('./array.json');
console.log("roots", inverse(zero) === -1/0, large === 9007199254740992, boolean === false, nil === null, text === "hello");
console.log("array", array === same, array[0] === 1, array[1] === "two", array[2] === null, array[3].ok === true);
