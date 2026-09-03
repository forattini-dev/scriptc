const source = new AbortController();
const combined = AbortSignal.any([source.signal]);

console.log(combined.aborted, combined.reason);
source.abort("stopped later");
console.log(combined.aborted, combined.reason);
