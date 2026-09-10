// @no-engine
function text(left: string, right: string): void {
  console.log(left < right, left <= right, left > right, left >= right);
}
text('\u{1f600}', '\ue000');
text('\ue000', '\u{1f600}');
text('a\u{1f600}', 'a\ue000');
text('a', 'aa');
text('same', 'same');
function numeric(left: number, right: number): void {
  console.log(left < right, left <= right, left > right, left >= right);
}
numeric(NaN, 0); numeric(0, NaN); numeric(-0, 0); numeric(Infinity, Infinity);
const missing: number[] = [];
console.log(missing[0] < 0, missing[0] <= 0, missing[0] > 0, missing[0] >= 0);
