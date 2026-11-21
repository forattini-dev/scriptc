// @rust-only
// @no-engine
async function value(): Promise<number> {
  console.log("start");
  return await Promise.resolve(7);
}
async function fail(): Promise<number> { throw "failure"; }
async function forward(): Promise<number> { return await fail(); }
async function pending(input: number): Promise<number> {
  const promise = Promise.resolve(input).then((result) => result + 1);
  return await promise;
}
async function local(input: number): Promise<number> {
  const value = await Promise.resolve(input).then((result) => result + 1);
  return value + 2;
}
async function localFailure(): Promise<number> {
  const value = await fail();
  return value + 2;
}
function throwBeforePromise(): Promise<number> { throw "before"; }
async function localThrow(): Promise<number> {
  const value = await throwBeforePromise();
  return value + 2;
}
async function localText(input: string): Promise<string> {
  const value = await Promise.resolve(input);
  return value + "!";
}
async function localConvert(input: number): Promise<string> {
  const value = await Promise.resolve(input);
  return "number:" + value;
}
async function withCapture(offset: number): Promise<number> {
  const value = await Promise.resolve(2);
  return value + offset;
}
async function withEffects(input: number): Promise<number> {
  const offset = 3;
  console.log("before suspension", offset);
  const value = await Promise.resolve(input);
  console.log("after suspension", value, offset);
  return value + offset;
}
async function writeAfterAwait(object: { value: number }, input: number): Promise<number> {
  const value = await Promise.resolve(input);
  object.value = value;
  return object.value + value;
}
async function writeAfterFailure(object: { value: number }): Promise<number> {
  const value = await fail();
  object.value = value;
  return object.value;
}
async function writeAwaitedLocal(): Promise<number> {
  let value = await Promise.resolve(2);
  value = 8;
  return value;
}
function withPostAwaitMutation(): Promise<number> {
  let shared = 1;
  const task = async (): Promise<number> => {
    const value = await Promise.resolve(7);
    shared = value;
    return shared;
  };
  const result = task();
  console.log("before mutation", shared);
  return result;
}
async function noEffectOnReject(): Promise<number> {
  const value = await fail();
  console.log("must not run", value);
  return value;
}
function withMutableCapture(): Promise<number> {
  let shared = 1;
  const task = async (): Promise<number> => {
    const value = await Promise.resolve(2);
    return value + shared;
  };
  const result = task();
  shared = 9;
  return result;
}
function withMutableObject(): Promise<number> {
  let object = { value: 1 };
  const task = async (): Promise<number> => {
    const value = await Promise.resolve(2);
    return value + object.value;
  };
  const result = task();
  object.value = 6;
  object = { value: 9 };
  return result;
}
class Observed {
  value = 1;
  get current(): number { console.log("getter"); return this.value; }
}
class Explodes {
  get current(): number { console.log("throwing getter"); throw "getter failure"; }
}
function withThrowingGetter(): Promise<number> {
  const object = new Explodes();
  const task = async (): Promise<number> => {
    const value = await Promise.resolve(2);
    console.log("before getter", value);
    return value + object.current;
  };
  return task();
}
function withGetter(): Promise<number> {
  const object = new Observed();
  const task = async (): Promise<number> => {
    const value = await Promise.resolve(2);
    return value + object.current;
  };
  const result = task();
  object.value = 8;
  return result;
}
let sharedGlobal = 1;
async function nestedBefore(): Promise<number> { return sharedGlobal + await Promise.resolve(2); }
async function nestedAfter(): Promise<number> { return (await Promise.resolve(2)) + sharedGlobal; }
function markOperand(label: string, value: number): number { console.log("operand", label); return value; }
async function nestedEffectBefore(): Promise<number> { return markOperand("before", 3) + await Promise.resolve(2); }
async function nestedEffectAfter(): Promise<number> { return (await Promise.resolve(2)) + markOperand("after", 5); }
async function nestedFailure(): Promise<number> { return markOperand("before rejection", 1) + await fail(); }
async function nestedStringBefore(): Promise<string> { return "prefix:" + await Promise.resolve("value"); }
async function nestedStringAfter(): Promise<string> { return (await Promise.resolve("value")) + ":suffix"; }
async function nestedStringFlow(early: boolean): Promise<string> {
  const first = await Promise.resolve("head");
  if (early) return first + ":early";
  const header = first + ":";
  return header + (await Promise.resolve("tail"));
}
function addTen(value: number): number { return value + 10; }
function addTwenty(value: number): number { return value + 20; }
let selected = addTen;
async function nestedCall(): Promise<number> { return selected(await Promise.resolve(1)); }
async function nestedCallFailure(): Promise<number> { return selected(await fail()); }
async function withGlobalCapture(): Promise<number> {
  const value = await Promise.resolve(2);
  return value + sharedGlobal;
}
function makeAwaiter(value: number): () => Promise<number> {
  return async () => await Promise.resolve(value);
}
const empty = async (): Promise<void> => await Promise.resolve();
value().then((result) => { console.log("result", result); });
forward().then((result) => { console.log("unexpected", result); }, (reason) => { console.log("rejected", reason === "failure"); });
pending(5).then((result) => { console.log("pending", result); });
local(5).then((result) => { console.log("local", result); });
localFailure().then((result) => { console.log("unexpected local", result); }, (reason) => { console.log("local rejected", reason === "failure"); });
localThrow().then((result) => { console.log("unexpected throw", result); }, (reason) => { console.log("source threw", reason === "before"); });
localText("ok").then((result) => { console.log("local text", result); });
localConvert(4).then((result) => { console.log("local convert", result); });
withCapture(5).then((result) => { console.log("captured parameter", result); });
withEffects(4).then((result) => { console.log("effects result", result); });
const writeTarget = { value: 1 };
writeAfterAwait(writeTarget, 7).then((result) => { console.log("record write", result, writeTarget.value); });
console.log("record before", writeTarget.value);
const rejectTarget = { value: 1 };
writeAfterFailure(rejectTarget).then((result) => { console.log("unexpected record", result); }, (reason) => { console.log("record untouched", rejectTarget.value === 1, reason === "failure"); });
withPostAwaitMutation().then((result) => { console.log("local write", result); });
writeAwaitedLocal().then((result) => { console.log("awaited local write", result); });
noEffectOnReject().then((result) => { console.log("unexpected effects", result); }, (reason) => { console.log("effects rejected", reason === "failure"); });
withMutableCapture().then((result) => { console.log("captured mutable", result); });
withMutableObject().then((result) => { console.log("captured object", result); });
withGetter().then((result) => { console.log("captured getter", result); });
withThrowingGetter().then((result) => { console.log("unexpected getter", result); }, (reason) => { console.log("getter rejected", reason === "getter failure"); });
withGlobalCapture().then((result) => { console.log("captured global", result); });
nestedBefore().then((result) => { console.log("nested before", result); });
nestedAfter().then((result) => { console.log("nested after", result); });
nestedEffectBefore().then((result) => { console.log("effect before", result); });
nestedEffectAfter().then((result) => { console.log("effect after", result); });
nestedFailure().then((result) => { console.log("unexpected nested", result); }, (reason) => { console.log("nested rejected", reason === "failure"); });
nestedStringBefore().then((result) => { console.log("nested string before", result); });
nestedStringAfter().then((result) => { console.log("nested string after", result); });
nestedStringFlow(false).then((result) => { console.log("nested string flow", result); });
nestedStringFlow(true).then((result) => { console.log("nested string early", result); });
const selectedResult = nestedCall();
selected = addTwenty;
selectedResult.then((result) => { console.log("nested call snapshot", result); });
nestedCallFailure().then((result) => { console.log("unexpected call", result); }, (reason) => { console.log("nested call rejected", reason === "failure"); });
sharedGlobal = 6;
makeAwaiter(9)().then((result) => { console.log("captured", result); });
empty().then(() => { console.log("empty"); });
Promise.resolve(1).then((result) => { console.log("microtask", result); });
console.log("sync");
