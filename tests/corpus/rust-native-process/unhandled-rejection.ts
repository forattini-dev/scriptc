// @rust-only
// @no-engine
function register(prefix: string): void {
  process.on("unhandledRejection", (reason) => { console.log("first", prefix === "first", reason === "failed"); });
}
register("first");
process.on("unhandledRejection", (reason) => { console.log("second", reason === "failed"); });
async function fail(): Promise<void> { throw "failed"; }
async function failAgain(): Promise<void> { throw "another"; }
void fail();
void failAgain();
console.log("sync");
