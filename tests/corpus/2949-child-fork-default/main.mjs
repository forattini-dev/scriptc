import childProcess from "node:child_process";

const child = childProcess.fork(new URL("./worker.mjs", import.meta.url), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});

child.once("message", (message) => {
  console.log(JSON.stringify(message));
});
