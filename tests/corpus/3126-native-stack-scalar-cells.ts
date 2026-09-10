function pixels(count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    let value: number;
    switch (i % 4) {
      case 0: value = i; break;
      case 1: value = i + 10; break;
      case 2: value = -i; break;
      default: value = i * 2;
    }
    sum += value;
  }
  return sum;
}
console.log("pixels", pixels(12), pixels(0));

function protectedWrites(fail: boolean): number {
  let value: number;
  try {
    value = 3;
    if (fail) throw new Error("change path");
    value = 5;
  } catch {
    value = 7;
  } finally {
    // A synchronous generated closure must share the same stack cell.
    value = fail ? 11 : 13;
  }
  return value;
}
console.log("protected", protectedWrites(false), protectedWrites(true));

function conditionals(n: number): void {
  let ready: boolean;
  ready = n > 0;
  let value: number;
  if (ready) {
    value = -0;
    console.log("zero", Object.is(value, -0));
    console.log("increment", value++, ++value, value);
  }
  for (let i = 0; i < n; i++) {
    let sometimes: number;
    if (i % 2 === 0) { sometimes = i + 1; console.log("sometimes", sometimes); }
  }
  console.log("ready", ready);
}
conditionals(3); conditionals(0);

function switchScope(route: number): void {
  switch (route) {
    case 0:
      let scratch: number;
      scratch = 17;
      console.log("scratch", scratch);
    case 1:
      let next = 21;
      next++;
      console.log("next", next);
      break;
    default: console.log("default");
  }
}
switchScope(0); switchScope(1); switchScope(2);

function captures(): () => number {
  let shared: number;
  const read = (): number => shared;
  shared = 21;
  const inc = (): void => { shared++; };
  inc();
  console.log("captured", read());
  return read;
}
console.log("escaped", captures()());

async function suspension(): Promise<number> {
  let value: number;
  value = 31;
  await Promise.resolve();
  value++;
  return value;
}
console.log("await", await suspension());

function* resumption(): Generator<number> {
  let value: number;
  value = 41;
  yield value;
  value++;
  yield value;
}
const it = resumption();
console.log("generator", it.next().value, it.next().value, it.next().done);
