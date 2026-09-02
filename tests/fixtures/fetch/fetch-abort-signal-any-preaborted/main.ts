// @dynamic
// Among already-aborted inputs, iterable order chooses the reason.
const first = new AbortController();
const second = new AbortController();
first.abort("first");
second.abort("second");
const signal = AbortSignal.any([second.signal, first.signal]);
console.log(signal.aborted, signal.reason as string);
