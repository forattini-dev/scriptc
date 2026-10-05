// @rust-only
// @no-engine
function copy(value) { return Buffer.from(value).toString('hex'); }
const array = JSON.parse('[1,2]');
array.valueOf = function () { return 'abc'; };
console.log(copy(array));
array.valueOf = function () { return array; };
console.log(copy(array));
array.valueOf = function () { throw new Error('conversion stopped'); };
try { copy(array); } catch (error) { console.log(error.name, error.message); }
