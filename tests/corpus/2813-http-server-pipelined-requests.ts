// Two pipelined requests arriving in ONE TCP segment: the bytes after the
// first request's body must be preserved and dispatched as the second
// request, not discarded with the buffer. The first request rides the
// HTTP/1.1 keep-alive default; the second closes the connection.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => {
  console.log("request", req.url);
  res.end(`resp:${req.url}`);
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end(
      "GET /a HTTP/1.1\r\n" +
      "Host: loopback.test\r\n\r\n" +
      "GET /b HTTP/1.1\r\n" +
      "Host: loopback.test\r\n" +
      "Connection: close\r\n\r\n",
    );
  });
  let raw = "";
  client.on("data", (chunk) => {
    raw += chunk.toString("utf8");
  });
  client.on("end", () => {
    console.log("statuses", raw.split("HTTP/1.1 200").length - 1);
    console.log("a", raw.includes("resp:/a"));
    console.log("b", raw.includes("resp:/b"));
    server.close();
  });
});
