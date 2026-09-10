// @no-engine
let trace = "";
async function step(name: string, value: unknown): Promise<unknown> {
  trace += name + ";";
  await Promise.resolve(0);
  return value;
}
async function run(value: unknown): Promise<void> {
  trace = "";
  switch (await step("disc", value)) {
    default: trace += "default;";
    case await step("one", 1): trace += "body-one;"; break;
    case await step("two", 2): trace += "body-two;"; break;
  }
  console.log(trace);
}
await run(1);
await run(2);
await run(3);
async function rejectCase(): Promise<unknown> {
  trace += "reject;";
  await Promise.resolve(0);
  throw new Error("case rejected");
}
async function protectedRun(value: unknown): Promise<void> {
  trace = "";
  try {
    switch (value) {
      case await step("hit", 1): trace += "hit-body;"; break;
      case await rejectCase(): trace += "wrong-body;"; break;
      default: trace += "wrong-default;";
    }
  } catch (error) { trace += String(error) + ";"; }
  finally { trace += "finally;"; }
  console.log(trace);
}
await protectedRun(1);
await protectedRun(2);

let changing: unknown = "original";
async function mutate(): Promise<unknown> {
  changing = "changed";
  await Promise.resolve(0);
  return "miss";
}
async function savedDiscriminant(): Promise<void> {
  switch (changing) {
    case await mutate(): console.log("wrong mutation"); break;
    case await step("saved", "original"): console.log("saved", changing); break;
    default: console.log("wrong saved");
  }
  console.log("after", changing);
}
await savedDiscriminant();

async function noDefault(value: unknown): Promise<void> {
  trace = "";
  switch (value) {
    case await step("one", 1): trace += "one-body;";
    case await step("two", 2): trace += "two-body;"; break;
  }
  console.log(trace);
}
await noDefault(1);
await noDefault(3);
export {};
