var original = exports;
exports.old = "old";
module.exports = { value: 9 };
exports.late = "alias";
module.exports.original = original;
exports = { lost: "rebound" };
module.exports.rebound = exports.lost;
