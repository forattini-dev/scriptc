import * as net from "node:net";

// The differential harness delays the payload long enough to distinguish a
// descriptor wait from the runtime's former 1 ms sleep loop.
const before = process.resourceUsage().voluntaryContextSwitches;
const socket = net.connect(Number(process.argv[2]), "127.0.0.1");
socket.on("data", (chunk) => {
  const after = process.resourceUsage().voluntaryContextSwitches;
  console.log(chunk.toString(), after - before < 100);
  socket.end();
});
