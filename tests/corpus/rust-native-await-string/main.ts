// @rust-only
// @no-engine
async function lower(): Promise<string> {
  console.log("start");
  return (await Promise.resolve(" HELLO ")).toLowerCase();
}
async function trim(): Promise<string> {
  return (await Promise.resolve("  hello  ")).trim();
}
async function fail(): Promise<string> { throw "failure"; }
async function rejected(): Promise<string> { return (await fail()).toLowerCase(); }
async function local(): Promise<string> { const value = (await Promise.resolve(" hi ")).toUpperCase(); return value; }
async function localRejected(): Promise<string> { const value = (await fail()).trim(); return value; }
lower().then((result) => console.log("lower", result));
trim().then((result) => console.log("trim", result));
rejected().then((result) => console.log("unexpected", result), (reason) => console.log("rejected", reason === "failure"));
local().then((result) => console.log("local", result));
localRejected().then((result) => console.log("unexpected local", result), (reason) => console.log("local rejected", reason === "failure"));
console.log("sync");
