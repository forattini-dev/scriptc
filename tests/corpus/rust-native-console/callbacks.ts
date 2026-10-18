// @rust-only
// @no-engine
export {};
function emit(message: string, sink: (s: string) => void): void { sink(message); }
emit("stdout log", console.log);
emit("stdout info", console.info);
emit("stdout debug", console.debug);
emit("stderr warn", console.warn);
emit("stderr error", console.error);
emit("literal %s/%d/%%", console.log);
console.warn("direct", 7, false);
console.info("direct", 8, true);
