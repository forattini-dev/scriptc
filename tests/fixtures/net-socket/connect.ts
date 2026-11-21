import * as net from "node:net";
const socket = new net.Socket();
socket.once("connect", function (this: net.Socket) {
  console.log("connected", this === socket);
  socket.destroy();
});
socket.once("error", () => console.log("error"));
const port = Number(process.env.SCRIPTC_TEST_PORT);
console.log("returned", socket.connect(port, "127.0.0.1") === socket);
