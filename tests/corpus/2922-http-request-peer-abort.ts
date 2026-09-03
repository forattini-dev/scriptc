import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((request, _response) => {
  request.on("aborted", () => {
    console.log("aborted", request.aborted, request.complete, request.destroyed);
  });
  request.on("end", () => console.log("end"));
  request.on("close", () => {
    console.log("close", request.aborted, request.complete, request.destroyed);
    server.close();
  });
  request.resume();
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end(
      "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\na",
    );
  });
  client.on("error", () => {});
});
