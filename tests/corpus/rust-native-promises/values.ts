// @rust-only
// @no-engine
Promise.resolve([1, 2]).then((values) => { console.log("array", values[0], values[1]); });
Promise.resolve((n: number): number => n + 1).then((fn) => { console.log("function", fn(4)); });
const fault = new Error("native");
Promise.resolve(fault).then((value) => { console.log("error", value === fault, value.message); });
const held: { promise: unknown } = { promise: undefined };
const promise = Promise.resolve(held);
held.promise = promise;
promise.then((value) => { console.log("cycle", value === held, value.promise === promise); });
Promise.resolve({ then: 3, value: "data" }).then((value) => { console.log("data", value.value); });
Promise.resolve(1).then(() => undefined).then((value) => { console.log("returned-undefined", value === undefined); });
Promise.resolve(1).then(() => null).then((value) => { console.log("returned-null", value === null); });
function shadow(): void {
  const Promise = { resolve: (value: number): number => value + 1 };
  console.log("shadow", Promise.resolve(2));
}
shadow();
