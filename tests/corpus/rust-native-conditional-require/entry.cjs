var proc = require('node:process');
var core;
console.log('before', core === undefined);
if (proc.env.SCRIPTC_NATIVE_REQUIRE_SIDE === 'right') {
  core = require('./right.cjs');
} else {
  core = require('./left.cjs');
}
console.log('selected', core.side);
var alias = core;
alias.count = 7;
var repeated;
if (proc.env.SCRIPTC_NATIVE_REQUIRE_SIDE === 'right') {
  repeated = require('./right.cjs');
} else {
  repeated = require('./left.cjs');
}
console.log('cached', repeated === core, repeated.count === 7);
if (false) require('./unselected.cjs');
console.log('after');
