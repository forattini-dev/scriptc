import { request } from "node:http";
import { createServer } from "node:net";

const server = createServer((socket) => {
  let wire = "";
  let answered = false;
  socket.on("data", (chunk: Buffer) => {
    wire += chunk.toString("utf8");
    if (!answered && wire.includes("0\r\nX-End: yes\r\n\r\n")) {
      answered = true;
      const split = wire.indexOf("\r\n\r\n");
      const head = wire.slice(0, split);
      const body = wire.slice(split + 4);
      console.log(`explicit chunked=${head.includes("Transfer-Encoding: chunked")} body=${body.split("\r\n").join("|")}`);
      socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok");
    }
  });
});

server.listen(0, () => {
  const outbound = request({ port: server.address().port, method: "POST", headers: { "Transfer-Encoding": "chunked", Trailer: "X-End" } }, (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    response.on("end", () => {
      console.log(`response body=${body} trailers=${response.rawTrailers.length}`);
      server.close();
    });
  });
  outbound.addTrailers({ "X-End": "yes" });
  outbound.end("hi");
});
