// @exit: 3
// Node exposes _exiting as false during ordinary execution and flips it
// before dispatching the synchronous exit listeners.
console.log("before", process._exiting);
process.once("exit", (code) => {
  console.log("exit", code, process._exiting);
});
process.exit(3);
