var proc = require('node:process');
exports.phase = 'starting';
var child;
if (proc.env.SCRIPTC_NATIVE_REQUIRE_SIDE === 'right') {
  child = require('./cycle-right.cjs');
} else {
  child = require('./cycle-left.cjs');
}
console.log('partial', child.saw === 'starting', child.parent === exports);
exports.phase = 'done';
console.log('live', child.parent.phase === 'done');
