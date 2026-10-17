console.log('cycle right');
var parent;
if (true) parent = require('./cycles.cjs');
exports.saw = parent.phase;
exports.parent = parent;
