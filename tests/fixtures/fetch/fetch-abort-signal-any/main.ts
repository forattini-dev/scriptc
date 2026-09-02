// @dynamic
// A composite signal is distinct and adopts only the first future abort.
const first = new AbortController();
const second = new AbortController();
const signal = AbortSignal.any([first.signal, second.signal]);
console.log(signal !== first.signal, signal !== second.signal, signal.aborted);
second.abort("second");
console.log(signal.aborted, signal.reason as string);
first.abort("first");
console.log(signal.reason as string);
