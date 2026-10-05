function copy(value) { return Buffer.from(value); }
const left = JSON.parse('{}');
const right = JSON.parse('{}');
left.valueOf = function () { return right; };
right.valueOf = function () { return left; };
copy(left);
