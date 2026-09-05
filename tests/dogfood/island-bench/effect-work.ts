import { Effect } from "effect";

const work = (i: number) =>
  Effect.gen(function* () {
    let acc = 0;
    for (let k = 0; k < 50; k++) acc = (acc * 31 + i + k) % 1000003;
    const doubled = yield* Effect.succeed(acc * 2);
    return doubled % 97;
  });

export async function runFibers(n: number): Promise<number> {
  const results = await Effect.runPromise(Effect.all(Array.from({ length: n }, (_, i) => work(i)), { concurrency: 64 }));
  let sum = 0;
  for (const r of results) sum += r;
  return sum;
}
