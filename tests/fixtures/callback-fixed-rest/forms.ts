function invoke(listener: (...args: any[]) => void) {
  listener({ value: 3 }, 7, 'extra');
  listener();
}

let total = 0;
invoke((first, second) => {
  if (first !== undefined) {
    total++;
  }
  console.log('fixed', first === undefined, second === undefined, total);
});

invoke(function (first) {
  console.log('function', first === undefined ? 'missing' : first.value);
});

invoke(() => {
  total++;
  console.log('zero', total);
});

const shared = { value: 11 };
function identity(listener: (...args: any[]) => void) { listener(shared, shared); }
identity((a, b) => {
  console.log('identity', a === b, a === shared);
});
