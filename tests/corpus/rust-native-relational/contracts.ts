// @rust-only
// @no-engine
// @ts-nocheck
function compare(a: unknown, b: unknown): void { console.log(a < b, a <= b, a > b, a >= b); }
compare(1, 2); compare(2, 2); compare(-0, 0); compare(1 / 0, -1 / 0);
compare('2', '10'); compare('abc', 'abd'); compare('', '');
compare('\u{10000}', '\uE000');
compare('😀'.slice(0, 1), '\uE000'); compare('😀'.slice(1), '\uE000');
compare(' 2 ', 10); compare(2, '0x10'); compare('', 0);
compare(false, true); compare(null, 0); compare(undefined, 0);
compare(0 / 0, 0); compare('bad', 1); compare('bad', 'abc');
const frame: { index: number; val: unknown } = { index: 0, val: ['a', 'b'] };
while (frame.index < frame.val.length) { console.log('frame', frame.index++); }
console.log('frame-end', frame.index);
console.log('typed', '2' < '10', '\u{10000}' < '\uE000', false < true, null <= 0);
