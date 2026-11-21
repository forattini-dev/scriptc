import { Socket } from "node:net";
const socket = new Socket();
socket.once("error", function (this: Socket, error: NodeJS.ErrnoException) { console.log("error", this === socket, error.code); });
socket.once("close", function (this: Socket, hadError: boolean) { console.log("closed", this === socket, hadError); });
socket.connect(Number(process.env.SCRIPTC_TEST_PORT), "127.0.0.1");
