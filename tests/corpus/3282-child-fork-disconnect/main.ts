// @rust-only
// Parent-side IPC teardown, and the two send spellings. 2946 covers the
// callback send and the worker-initiated disconnect; this program covers the
// parent-initiated `child.disconnect()`, the BARE `child.send(message)` with
// no callback, the difference between a channel that never existed and one
// that has been disconnected, that a burst of framed messages survives the
// EOF that follows it, that a send callback settles exactly once, and that the
// worker's exit code has a single source of truth (the last write wins and the
// parent observes exactly that value).
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

// NO channel at all: a spawned child was never given an IPC slot, so it
// reads as not connected. That is a different state from the disconnected
// channel asserted at the end of this program.
const plain = spawn("true", [], { stdio: "ignore" });
console.log("absent-channel", plain.connected);

const child = fork(worker, ["disconnect-fixture"], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
console.log("live-channel", child.connected);

// The bare send: no callback, so the result is the only signal.
console.log("send-bare", child.send({ kind: "first", index: 1 }));
// A burst handed over back to back. The worker must see every one of them
// even though the channel is torn down immediately after the reply.
console.log(
  "send-burst",
  child.send({ kind: "burst", index: 2 }),
  child.send({ kind: "burst", index: 3 }),
  child.send({ kind: "burst", index: 4 }),
);

let sendCallbackCalls = 0;
let lateCallbackCalls = 0;
child.send({ kind: "last", index: 5 }, (error) => {
  sendCallbackCalls += 1;
  console.log("send-callback", sendCallbackCalls, error === null);
});

child.on("message", (message: { seen: number[]; total: number }) => {
  console.log("worker-saw", message.total, message.seen.join(","));
  // Parent-initiated teardown, as its own statement.
  child.disconnect();
  // Node clears `connected` INSIDE disconnect(), so the very next read must
  // already see the channel as gone. That is the disconnected state, as
  // opposed to the never-existed one printed as `absent-channel` above.
  console.log("after-disconnect", child.connected);
  // A send on the closed channel is refused, and its callback settles once
  // with the channel-closed error rather than being dropped. (The bare
  // no-callback spelling is used above, while the channel is live: after
  // disconnect Node reports the failure on the child's `error` event, which
  // is a different surface from this one.)
  child.send({ kind: "late", index: 9 }, (error) => {
    lateCallbackCalls += 1;
    console.log("late-send", lateCallbackCalls, error !== null);
  });
});

child.once("disconnect", () => {
  console.log("parent-disconnect", child.connected);
});

child.once("exit", (code) => {
  // The worker wrote its exit code twice; the LAST write is what the parent
  // must see. `sendCallbackCalls` proves the callback settled exactly once.
  console.log("exit", code, sendCallbackCalls, lateCallbackCalls);
});
