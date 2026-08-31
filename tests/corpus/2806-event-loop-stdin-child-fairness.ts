import { spawn } from "node:child_process";

// An idle stdin listener must not monopolize the event-loop wait while a
// referenced child becomes ready. The watchdog makes starvation observable
// without allowing a broken runtime to hang the differential harness.
process.stdin.on("data", () => console.log("stdin"));

const child = spawn("sh", ["-c", "sleep 0.05"], { stdio: "ignore" });
const watchdog = setTimeout(() => {
  console.log("watchdog");
  process.stdin.destroy();
}, 2000);

child.on("exit", (code) => {
  clearTimeout(watchdog);
  console.log("child", code);
  process.stdin.destroy();
});
