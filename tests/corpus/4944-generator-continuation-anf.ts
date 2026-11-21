// @rust-only
// @no-engine
function* leaf(value: number): Generator<string, number, unknown> {
  yield `leaf:${value}`;
  return value;
}

function* nested(): Generator<string, number, unknown> {
  let current = 0;
  while (current < 1) current = yield* leaf(1);
  const sum = (yield* leaf(2)) + (yield* leaf(3));
  console.log(`sum:${current + sum}`);
  return current + sum;
}

function* source(): Generator<number, void, unknown> {
  yield 1;
  yield 2;
}

function* fixed(value: number): Generator<string, void, undefined> {
  yield `fixed:${value}`;
}

function* bridge(): Generator<string, void, undefined> {
  for (const value of source()) yield* fixed(value);
}

function* choose(tag: string): Generator<string, number, unknown> {
  switch (tag) {
    case "left":
      return yield* leaf(4);
    default:
      return yield* leaf(5);
  }
}

class Holder {
  value = 0;
  *fill(): Generator<string, number, unknown> {
    this.value = yield* leaf(6);
    console.log(`field:${this.value}`);
    return this.value;
  }
}

for (const token of nested()) console.log(token);
for (const token of bridge()) console.log(token);
for (const token of choose("left")) console.log(token);
for (const token of new Holder().fill()) console.log(token);
