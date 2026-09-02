// @dynamic
// AbortController exposes one signal and aborts it before fetch starts.
const controller = new AbortController();
const signal = controller.signal;
controller.abort();
try {
  await fetch(`${process.argv[2]}/text`, { signal });
  console.log("resolved");
} catch (error) {
  const reason = error as Error;
  console.log(
    controller.signal === signal,
    signal.aborted,
    reason.name,
    reason.message,
  );
}
