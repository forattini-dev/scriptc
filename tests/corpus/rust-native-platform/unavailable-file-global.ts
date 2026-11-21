// @rust-only
// @no-engine
export {};

console.log("File typeof", typeof File);
try {
  console.log({} instanceof File);
} catch (error) {
  console.log("File read", error instanceof ReferenceError);
}
