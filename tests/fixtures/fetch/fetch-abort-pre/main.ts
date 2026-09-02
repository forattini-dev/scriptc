// @dynamic
// A signal aborted before fetch starts rejects with Node's AbortError shape.
const signal = AbortSignal.abort();
const signalView: any = signal;
try {
  await fetch(`${process.argv[2]}/text`, { signal });
  console.log("resolved");
} catch (error) {
  const reason = error as Error;
  const code: number = signalView.reason.code;
  console.log(
    signal.aborted,
    code,
    reason.name,
    reason.message,
  );
}
