// @rust-only
// @no-engine
/// <reference types="node" />
import { createConnection } from "node:net";

const missing =
  process.platform === "win32"
    ? `\\\\.\\pipe\\scriptc-native-missing-${process.pid}`
    : `/tmp/scriptc-native-missing-${process.pid}.sock`;
const socket = createConnection(missing);
socket.on("data", (chunk) => {
  console.log(chunk.toString("utf8"));
});
socket.on("error", () => {
  console.log("local socket error");
});
