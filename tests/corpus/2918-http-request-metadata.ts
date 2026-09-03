import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((request, response) => {
  console.log(JSON.stringify(request.rawHeaders));
  console.log(JSON.stringify({ ...request.headers }));
  console.log(request.socket.remoteAddress);
  response.end();
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end(
      "GET / HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "X-Mixed-Case: first\r\n" +
      "Connection: close\r\n\r\n",
    );
  });
  client.on("data", () => {});
});
