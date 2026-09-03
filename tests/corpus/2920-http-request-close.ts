import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((request, response) => {
  request.on("end", () => {
    console.log("end", request.aborted, request.complete, request.destroyed);
  });
  request.on("close", () => {
    console.log("close", request.aborted, request.complete, request.destroyed);
    response.end();
    server.close();
  });
  request.resume();
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  });
  client.on("data", () => {});
});
