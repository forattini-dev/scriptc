import * as net from "node:net";

// The differential harness sends network data after this program has entered
// its wait phase. Idle stdin must not hide that socket readiness.
process.stdin.on("data", () => console.log("stdin"));

const socket = net.connect(Number(process.argv[2]), "127.0.0.1");
socket.on("data", (chunk) => {
  clearTimeout(watchdog);
  console.log(chunk.toString());
  process.stdin.destroy();
  socket.end();
});

const watchdog = setTimeout(() => {
  console.log("watchdog");
  process.stdin.destroy();
}, 2000);
