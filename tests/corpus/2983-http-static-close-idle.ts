import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((_incoming, outgoing) => outgoing.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1");
  let wire = "";
  socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n"));
  socket.on("data", (chunk: Buffer) => {
    wire += chunk.toString();
    if (wire.includes("\r\n\r\nok")) {
      console.log("response received");
      server.closeIdleConnections();
    }
  });
  socket.on("close", () => {
    console.log("idle socket closed");
    server.close();
  });
});
