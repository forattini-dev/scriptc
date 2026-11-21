function* numbers(seed: number): Generator<number, number, unknown> {
  const sent = yield seed;
  yield typeof sent === 'number' ? seed + sent : seed + 100;
  return seed + 2;
}
function recover(value: Generator<number, number, unknown>) { return value; }
for (let i = 0; i < 32; i++) {
  const original = numbers(i);
  const erased: any = original;
  const recovered = recover(erased);
  const again = recover(recovered as any);
  const first = recovered.next();
  const second = original.next(i + 1);
  const final = again.next();
  console.log(i, (recovered as any) === (original as any), (again as any) === (original as any),
    first.value, first.done, second.value, second.done, final.value, final.done);
}
