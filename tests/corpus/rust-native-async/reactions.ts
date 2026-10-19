// @rust-only
// @no-engine
async function fail(): Promise<number> { throw "initial"; }
const first = fail();
first.then(undefined, reason => { console.log("recover", reason as string); return Promise.resolve(8); })
  .then(value => { console.log("adopted", value); });
first.then().then(undefined, reason => { console.log("forwarded", reason as string); return 2; });
first.then(undefined, reason => { throw reason; })
  .then(undefined, reason => { console.log("thrown", reason as string); return 3; });
Promise.resolve(1).then(value => { console.log("success", value); return value; }, () => { console.log("wrong branch"); return 0; });
console.log("sync");

const fault = new TypeError("native rejection");
async function error(): Promise<number> { throw fault; }
error().then(undefined, reason => { console.log("error identity", reason === fault); return 0; });
async function record(): Promise<{ value: number }> { return { value: 12 }; }
record().then(value => { console.log("record", value.value); });
