// @dynamic
// Abort listeners run synchronously in registration order and only on the
// first transition to the aborted state.
const controller = new AbortController();
const seen: string[] = [];
controller.signal.addEventListener("abort", () => seen.push("first"));
controller.signal.addEventListener("abort", () => seen.push("second"));
controller.abort();
controller.abort();
console.log(seen.join(","), controller.signal.aborted);
