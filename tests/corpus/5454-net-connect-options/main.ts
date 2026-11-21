import { connect } from "node:net";

const socket = connect({ host: "127.0.0.1", port: 1 });
console.log(typeof socket.once);
socket.once("connect", () => console.log("connect"));
socket.once("error", () => console.log("error"));
