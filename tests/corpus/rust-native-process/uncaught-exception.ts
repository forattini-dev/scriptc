// @rust-only
// @no-engine
process.on("uncaughtException", (reason) => { console.log("caught", (reason as unknown) === "failure"); });
process.on("uncaughtException", (reason) => {
  console.log("second", (reason as unknown) === "later");
  if (typeof reason === "object" && reason !== null) console.log("wrapped", (reason as any).code === "ERR_UNHANDLED_REJECTION");
});
async function fail(): Promise<void> { throw "later"; }
void fail();
console.log("sync");
throw "failure";
