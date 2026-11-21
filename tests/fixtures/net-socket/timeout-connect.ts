import { Socket } from "node:net";
const socket = new Socket();
socket.once("connect", () => console.log("connected"));
socket.once("timeout", function (this: Socket) {
  console.log("timeout", this === socket);
  this.write("ping");
});
socket.once("data", function (this: Socket, data: Buffer) {
  console.log("data", this === socket, data.toString());
  this.destroy();
});
socket.once("error", () => console.log("error"));
socket.setTimeout(30);
socket.connect(Number(process.env.SCRIPTC_TEST_PORT), "127.0.0.1");
