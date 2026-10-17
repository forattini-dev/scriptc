var proc = require('node:process');
var path = require('path');
console.log("native", proc.platform === 'win32' || proc.platform === 'linux', path.basename('/a/file.txt'));
/** @param {{value: number}} exports */
function shadow(exports) { return exports.value; }
console.log("shadow", shadow({ value: 8 }));
