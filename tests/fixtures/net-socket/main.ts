import * as net from "node:net";
import { Socket } from "node:net";
const socket = new net.Socket();
const named = new Socket();
console.log("methods", typeof socket.connect, typeof socket.setTimeout);
console.log("identity", socket.setTimeout(10, () => console.log("callback")) === socket);
socket.on("timeout", () => console.log("timeout"));
setTimeout(() => {
  console.log("finished");
  socket.destroy();
  named.destroy();
}, 50);
