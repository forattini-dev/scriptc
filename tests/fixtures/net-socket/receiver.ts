import { Socket } from "node:net";
const socket = new Socket();
socket.on("timeout", function (this: Socket) { console.log("event", this === socket); });
socket.setTimeout(10, function (this: Socket) { console.log("callback", this === socket); });
setTimeout(() => { socket.destroy(); }, 50);
