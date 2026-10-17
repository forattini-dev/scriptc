var proc = require('node:process');
const value = require('./data.json');
console.log('start');
if (proc.env.SCRIPTC_NATIVE_REQUIRE_SIDE === 'right') {
  const value = require('./right.cjs');
  const alias = value;
  console.log('block', alias === value, value.side === 'right', value.side === 'left');
} else {
  const value = require('./left.cjs');
  const alias = value;
  console.log('block', alias === value, value.side === 'right', value.side === 'left');
}
if (false) { const skipped = require('./unselected.cjs'); console.log(skipped.unexpected === true); }
console.log('end', value.value === 1);
