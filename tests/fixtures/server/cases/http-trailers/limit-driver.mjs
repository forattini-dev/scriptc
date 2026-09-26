import { connect } from "node:net";

const port = Number(process.argv[2]);

function exchange(wire) {
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = connect(port, "127.0.0.1", () => socket.end(wire));
    socket.on("data", (chunk) => { response += chunk.toString("latin1"); });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
    socket.setTimeout(5000, () => reject(new Error("timeout")));
  });
}

const overflow = await exchange(
  "POST /limit HTTP/1.1\r\n" +
    "Host: test\r\n" +
    "Connection: close\r\n" +
    "Transfer-Encoding: chunked\r\n\r\n" +
    "0\r\n" +
    "X: y\r\n".repeat(1001) +
    "\r\n",
);
console.log(`limit ${overflow.split("\r\n")[0]}`);
await exchange("GET /quit HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
console.log("limit driver done");
