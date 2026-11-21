import { Socket } from "node:net";
const socket = new Socket();
socket.once("connect", function (this: Socket) {
  console.log("connected", this === socket);
  this.write("ping");
});
socket.once("data", function (this: Socket, data: Buffer) {
  console.log("data", this === socket, Buffer.isBuffer(data), data.toString());
  this.destroy();
});
socket.once("close", function (this: Socket, hadError: boolean) {
  console.log("closed", this === socket, hadError);
});
socket.once("error", () => console.log("error"));
socket.connect(Number(process.env.SCRIPTC_TEST_PORT), "127.0.0.1");
