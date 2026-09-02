// @dynamic
// Request owns a dependent signal: identity differs from the source, while
// abort state and reason propagate and cancel fetch(request).
const controller = new AbortController();
const request = new Request(`${process.argv[2]}/slow`, {
  signal: controller.signal,
});
const distinct = request.signal !== controller.signal;
const pending = fetch(request);
controller.abort();
console.log(distinct, controller.signal.aborted, request.signal.aborted);
try {
  await pending;
  console.log("resolved");
} catch (error) {
  const reason = error as Error;
  console.log(distinct, request.signal.aborted, reason.name, reason.message);
}
