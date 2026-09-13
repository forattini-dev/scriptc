function same(left: unknown, right: unknown): boolean { return left === right; }
async function report(label: string, action: () => Promise<unknown>): Promise<void> {
  try { console.log(label, await action()); }
  catch (error) { console.log(label, error instanceof Error ? error.message : error); }
}
async function main(): Promise<void> {
  await report("number", () => Promise.resolve(42));
  await report("string", () => Promise.resolve("ready"));
  await report("rejected", async (): Promise<number> => { throw new Error("original rejection"); });
  const source = Promise.resolve(7);
  const widened: Promise<unknown> = source;
  const callback: () => Promise<unknown> = () => source;
  console.log("identity", same(source, widened), same(callback(), source));
  widened.then(value => console.log("view reaction", value));
  source.then(value => console.log("source reaction", value));
  queueMicrotask(() => console.log("microtask"));
  await widened;

  const record = { value: 8, extra: "kept" };
  const recordPromise = Promise.resolve(record);
  const narrow: Promise<{ value: number }> = recordPromise;
  const erased: Promise<unknown> = recordPromise;
  const narrowed = await narrow;
  const erasedRecord = await erased;
  console.log("record", same(narrowed, record), same(erasedRecord, record));
  narrowed.value = 9;
  console.log("mutation", record.value);
  const array = [1, 2];
  const arrayView: Promise<unknown> = Promise.resolve(array);
  console.log("array", same(await arrayView, array));
  const union: Promise<number | string> = source;
  console.log("union", await union);
  const nothing: Promise<void> = Promise.resolve();
  const voidView: Promise<unknown> = nothing;
  console.log("void", same(nothing, voidView), await voidView);
  const optionalVoid: Promise<void | number> = nothing;
  console.log("void union", same(optionalVoid, nothing), await optionalVoid);

  let finish: (value: number) => void = () => {};
  const pending = new Promise<number>(resolve => { finish = resolve; });
  const pendingView: Promise<unknown> = pending;
  pendingView.then(value => console.log("pending view", value));
  pending.then(value => console.log("pending source", value));
  finish(11);
  await pendingView;
  const reason = new Error("same rejection");
  const rejected: Promise<number> = new Promise<number>((_resolve, reject) => reject(reason));
  const rejectedView: Promise<unknown> = rejected;
  try { await rejectedView; } catch (error) { console.log("rejection identity", same(error, reason)); }
}
main();
