// @rust-only
// process.on("uncaughtException"): a synchronous throw reaches the
// listener, the process keeps running for the listener's own async work
// (a timer here), and exits 0 unless the listener exits. An unhandled
// rejection reaches the same listener when no 'unhandledRejection'
// listener exists (Node's default --unhandled-rejections=throw).
process.on("uncaughtException", (err) => {
  console.log("caught:", err instanceof Error ? err.message : String(err));
  setTimeout(() => console.log("after handler"), 5);
});
setTimeout(() => {
  console.log("timer runs");
  Promise.reject(new Error("rejected later"));
}, 1);
console.log("before throw");
throw new Error("boom");
