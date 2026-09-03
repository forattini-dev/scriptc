const pending = new AbortController();
const combined = AbortSignal.any([
  pending.signal,
  AbortSignal.abort("already stopped"),
]);

console.log(combined.aborted, combined.reason);
