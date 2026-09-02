// @dynamic
// AbortSignal.timeout changes state asynchronously and reports TimeoutError.
const signal = AbortSignal.timeout(5);
const signalView: any = signal;
const before = signal.aborted;
await new Promise<void>((resolve) => setTimeout(resolve, 25));
const code: number = signalView.reason.code;
const name: string = signalView.reason.name;
const message: string = signalView.reason.message;
console.log(before, signal.aborted, code, name, message);
