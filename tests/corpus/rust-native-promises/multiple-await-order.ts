async function step(value: number): Promise<number> { return value; }
async function fail(): Promise<number> { throw "failed"; }
async function sum(input: number): Promise<number> {
  console.log("start");
  const first = await step(input);
  console.log("first");
  const second = await step(first + 1);
  console.log("second");
  return first + second;
}
async function reject(): Promise<number> {
  const first = await step(1);
  const second = await fail();
  return first + second;
}
void sum(2).then((value) => console.log(value));
void reject().then((value) => console.log(value), (reason) => console.log(reason === "failed"));
console.log("sync");
