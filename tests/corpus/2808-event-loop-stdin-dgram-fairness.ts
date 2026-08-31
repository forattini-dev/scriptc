import { createSocket } from "node:dgram";

// The differential harness sends a datagram after this program has entered
// its wait phase. Idle stdin must not hide that socket readiness.
process.stdin.on("data", () => console.log("stdin"));

const socket = createSocket("udp4");
socket.on("listening", () => console.log("ready"));
socket.on("message", (message) => {
  clearTimeout(watchdog);
  console.log(message.toString());
  process.stdin.destroy();
  socket.close();
});
socket.bind(Number(process.argv[2]), "127.0.0.1");

const watchdog = setTimeout(() => {
  console.log("watchdog");
  process.stdin.destroy();
}, 2000);
