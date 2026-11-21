// @rust-only
// @no-engine
export {};

type Result = { value: number };
const results: Array<Result | Promise<Result>> = [];
results.push({ value: 2 });
results.push(Promise.resolve({ value: 5 }));
Promise.all(results).then((values) => {
  console.log("all values", values.map((value) => value.value).join(","));
});
