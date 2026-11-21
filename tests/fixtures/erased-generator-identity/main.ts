function* numbers(): Generator<number, number, unknown> {
  yield 1;
  yield 2;
  return 3;
}
function recover(value: Generator<number, number, unknown>) { return value; }
const original = numbers();
const erased: any = original;
const recovered = recover(erased);
console.log('identity', (recovered as any) === (original as any));
console.log(JSON.stringify(recovered.next()), JSON.stringify(original.next()), JSON.stringify(recovered.next()));
