// A real HTTP/1.1 server round-trip driven by the already-supported raw
// node:net client. This pins the Rust server parser and response framing
// independently from the native HTTP client implementation.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => {
  console.log("request", req.method, req.url, req.headers.host);
  res.statusCode = 201;
  res.setHeader("X-Runtime", "rust-http");
  res.write("hello ");
  res.end(`${req.method} ${req.url}`);
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end(
      "GET /native?q=1 HTTP/1.1\r\n" +
      "Host: loopback.test\r\n" +
      "Connection: close\r\n\r\n",
    );
  });
  let raw = "";
  client.on("data", (chunk) => {
    raw += chunk.toString("utf8");
  });
  client.on("end", () => {
    const separator = raw.indexOf("\r\n\r\n");
    console.log("status", raw.slice(0, raw.indexOf("\r\n")));
    console.log("header", raw.includes("X-Runtime: rust-http"));
    console.log("body", raw.slice(separator + 4));
    server.close();
  });
});
