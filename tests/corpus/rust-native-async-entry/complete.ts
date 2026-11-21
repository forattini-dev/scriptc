// @rust-only
// @no-engine
export {};
console.log("module start");
Promise.resolve(1).then(() => { console.log("queued"); });
await Promise.resolve(3);
