console.log("leaf:init");
exports.value = 4;
exports.value = 7;
/** @param {number} value */
function twice(value) { return value * 2; }
exports.twice = twice;
/** @param {number} value */
function change(value) { exports.value = value; }
exports.change = change;
