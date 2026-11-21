function observe(value: { number: number }) {
  console.log(JSON.stringify(value), Object.keys(value).join(','), typeof value.number);
  console.log(value.number + 1, value.number - 1, value.number * 2, value.number / 2);
  console.log(value.number % 2, value.number ** 2, value.number | 1, value.number << 1);
  console.log(value.number ?? 99, value.number === undefined, String(value.number));
}
function run(values: number[]) {
  const [parent, ...children] = values;
  observe({ number: parent! });
  console.log(children.length, JSON.stringify(children), typeof children[0], Object.keys(children).join(','));
}
run([7, 8]);
run([0]);
run([]);
const holes: number[] = [];
holes.length = 2;
run(holes);
