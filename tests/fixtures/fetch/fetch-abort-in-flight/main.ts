// @dynamic
// A timeout that fires while host I/O is pending rejects the public fetch.
const signal = AbortSignal.timeout(20);
try {
  await fetch(`${process.argv[2]}/slow`, { signal });
  console.log("resolved");
} catch (error) {
  const reason = error as Error;
  console.log(signal.aborted, reason.name, reason.message);
}
