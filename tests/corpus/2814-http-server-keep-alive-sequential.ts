// Two sequential requests over one kept-alive connection: the server must
// honor the HTTP/1.1 keep-alive default (no unconditional Connection:
// close, no unconditional socket end after the response) and reset its
// per-request state so the second head parses from a clean buffer. The
// client only writes the second request after the first response body has
// fully arrived.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => {
  console.log("request", req.url);
  res.end(`resp:${req.url}`);
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.write(
      "GET /first HTTP/1.1\r\n" +
      "Host: loopback.test\r\n\r\n",
    );
  });
  let raw = "";
  let second = false;
  client.on("data", (chunk) => {
    raw += chunk.toString("utf8");
    if (!second && raw.includes("resp:/first")) {
      second = true;
      client.end(
        "GET /second HTTP/1.1\r\n" +
        "Host: loopback.test\r\n" +
        "Connection: close\r\n\r\n",
      );
    }
  });
  client.on("end", () => {
    console.log("statuses", raw.split("HTTP/1.1 200").length - 1);
    console.log("first", raw.includes("resp:/first"));
    console.log("second", raw.includes("resp:/second"));
    server.close();
  });
});
