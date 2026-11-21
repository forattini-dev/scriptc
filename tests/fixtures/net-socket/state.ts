import { Socket } from "node:net";
const socket = new Socket();
console.log("initial", socket.destroyed, socket.connecting, socket.readable, socket.writable, typeof socket.timeout, socket.bytesWritten);
socket.setTimeout(0);
console.log("timeout", socket.timeout);
socket.destroy();
console.log("destroyed", socket.destroyed, socket.readable, socket.writable);
