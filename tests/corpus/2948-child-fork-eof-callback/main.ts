import * as childProcess from "node:child_process";

const child = childProcess.fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});

const events: string[] = [];
child.send({ value: 1 }, (error) => {
  events.push(error ? "send:error" : "send:ok");
});
child.once("disconnect", () => {
  events.push("disconnect");
});
child.once("close", () => {
  console.log(events.join(","));
});
