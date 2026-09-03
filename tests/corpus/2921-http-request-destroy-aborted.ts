import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((request, _response) => {
  console.log("before", request.aborted, request.complete, request.destroyed);
  request.on("aborted", () => {
    console.log("aborted", request.aborted, request.complete, request.destroyed);
  });
  request.on("close", () => {
    console.log("close", request.aborted, request.complete, request.destroyed);
    server.close();
  });
  request.destroy();
  console.log("after destroy");
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\na");
    client.resume();
  });
  client.on("error", () => {});
});
