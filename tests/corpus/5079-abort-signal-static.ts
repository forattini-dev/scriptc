// @ts-nocheck
const stopped = AbortSignal.abort("stop");
const combined = AbortSignal.any([stopped, AbortSignal.timeout(1000)]);
const aborted: boolean = combined.aborted;
console.log(aborted);
