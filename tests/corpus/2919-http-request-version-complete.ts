import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((request, response) => {
  console.log(request.httpVersion, request.httpVersionMajor, request.httpVersionMinor);
  request.on("end", () => {
    console.log(request.complete);
    response.end();
    server.close();
  });
  request.resume();
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
  });
  client.on("data", () => {});
});
