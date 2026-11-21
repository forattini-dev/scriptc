const left = { test: /a/ };
const right = { test: /b/, extra: true };

function pick(value) {
  const selected = value ? left : right;
  return selected.test.test('a');
}

console.log(pick(true), pick(false));
