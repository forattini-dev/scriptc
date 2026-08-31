// A chunked-transfer request body decoded by the server: several chunks,
// a chunk extension that must be ignored, and the terminating 0-chunk.
// Driven by the raw node:net client so the server-side decoder is pinned
// independently from the native HTTP client.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => {
  console.log("te", req.headers["transfer-encoding"]);
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => {
    console.log("body", JSON.stringify(body));
    res.end(`got ${body.length}`);
  });
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end(
      "POST /upload HTTP/1.1\r\n" +
      "Host: loopback.test\r\n" +
      "Transfer-Encoding: chunked\r\n" +
      "Connection: close\r\n\r\n" +
      "4\r\nWiki\r\n" +
      "5;ext=zero\r\npedia\r\n" +
      "E\r\n in\r\n\r\nchunks.\r\n" +
      "0\r\n\r\n",
    );
  });
  let raw = "";
  client.on("data", (chunk) => {
    raw += chunk.toString("utf8");
  });
  client.on("end", () => {
    const separator = raw.indexOf("\r\n\r\n");
    console.log("status", raw.slice(0, raw.indexOf("\r\n")));
    console.log("reply", raw.slice(separator + 4));
    server.close();
  });
});
