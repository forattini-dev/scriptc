// @no-engine
function compare(left: any, right: any): void {
  console.log(left < right, left <= right, left > right, left >= right);
}
const values: unknown[] = [undefined, null, false, true, NaN, -0, 0, -1, 2, Infinity, '', '2', '10', 'bad', [], [2], [1, 2], {}];
for (const left of values) for (const right of values) compare(left, right);
compare('\u{1f600}', '\ue000');
compare('\ue000', '\u{1f600}');
compare('a\u{1f600}', 'a\ue000');
compare('a', 'aa');
const missing: string[] = [];
console.log(missing[0] < 'z', missing[0] >= 'a');
