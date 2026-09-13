// @rust-only
// @no-engine
function binary(left, right) {
  console.log(String(left + right), String(left - right), String(left * right), String(left / right), String(left % right), String(left ** right));
}
function compare(left, right) {
  console.log(left < right, left <= right, left > right, left >= right);
}
function unary(value) { console.log(typeof value, String(-value), Number(value), Boolean(value)); }
binary(17n, 3n);
binary(17, 3);
unary(9007199254740993n);
unary(0n);
compare(9007199254740993n, 9007199254740992);
compare(9007199254740992, 9007199254740993n);
compare(9007199254740993n, '9007199254740993');
compare('9007199254740992', 9007199254740993n);
compare(1n, '1.5');
compare(1n, NaN);
compare(1n, Infinity);
compare(-1n, -Infinity);
compare(0n, false);
compare(null, 0n);
let order = '';
function operand(label, value) {
  order += label;
  return { valueOf() { order += label.toLowerCase(); return value; } };
}
// @ts-expect-error ECMAScript applies ToPrimitive to objects for addition.
console.log(String(operand('L', 5n) + operand('R', 7n)), order);
console.log(String(3n + ' apples'));
function failure(run) {
  try { console.log(String(run())); } catch (error) { console.log(error.name, error.message); }
}
function mixed(left, right, op) {
  if (op === '+') return left + right;
  if (op === '-') return left - right;
  if (op === '*') return left * right;
  if (op === '/') return left / right;
  if (op === '%') return left % right;
  return left ** right;
}
for (const op of ['+', '-', '*', '/', '%', '**']) failure(() => mixed(1n, 2, op));
function positive(value) { return +value; }
failure(() => positive(1n));
