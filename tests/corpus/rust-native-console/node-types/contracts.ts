// @rust-only
// @no-engine
export {};
const print: typeof console.log = console.log;
function emit(sink: (message: string) => void): void { sink("Node declarations callback"); }
emit(print);
console.warn("Node declarations warning");
console.log("Node declarations identity", print === console.log);
