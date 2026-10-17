var proc = require('node:process');
var value;
var early = value;
console.log('initial', early === undefined);
if (proc.env.SCRIPTC_NATIVE_REQUIRE_SIDE === 'right') {
  value = require('./right.cjs');
} else {
  value = require('./left.cjs');
}
var late = value;
exports.child = require('./data.json');
var data = require('./data.json');
console.log('aliases', late === value, late.side, exports.child === data);
exports.child.value = 8;
console.log('mutation', data.value === 8);
