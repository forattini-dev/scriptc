// The forked side. It records every framed message it receives, replies once
// the sentinel arrives, and writes its exit code TWICE so the parent can
// confirm the last write is the one that survives.
const seen: number[] = [];

// An early write that a later one must override.
process.exitCode = 9;

process.on("message", (message: { kind: string; index: number }) => {
  seen.push(message.index);
  if (message.kind !== "last") return;
  process.send?.({ seen, total: seen.length }, (error) => {
    if (error) process.exit(2);
    // The surviving write. The parent asserts it observes exactly 4.
    process.exitCode = 4;
  });
});

process.once("disconnect", () => {
  // The channel is gone; nothing further may be sent. Recording the argv
  // proves the worker really is the forked side and not a re-run of main.
  if (process.argv.length < 3) process.exitCode = 5;
});
