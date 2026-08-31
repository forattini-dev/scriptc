import { createSocket } from "node:dgram";

// The differential harness waits after the bind handshake before sending.
// A descriptor wait should not wake the runtime every millisecond.
const before = process.resourceUsage().voluntaryContextSwitches;
const socket = createSocket("udp4");
socket.on("listening", () => console.log("ready"));
socket.on("message", (message) => {
  const after = process.resourceUsage().voluntaryContextSwitches;
  console.log(message.toString(), after - before < 100);
  socket.close();
});
socket.bind(Number(process.argv[2]), "127.0.0.1");
