import * as http from "node:http";
import * as net from "node:net";

const sink = net.createServer((socket) => {
  let body = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: any) => {
    body += chunk;
  });
  socket.on("end", () => {
    console.log(body);
    sink.close();
    server.close();
  });
});

let forwarding: net.Socket;

const server = http.createServer((request, response) => {
  request.on("end", () => response.end());
  request.pipe(forwarding);
});

sink.listen(0, "127.0.0.1", () => {
  forwarding = net.connect(sink.address().port, "127.0.0.1", () => {
    server.listen(0, "127.0.0.1", () => {
      const request = http.request({
        host: "127.0.0.1",
        port: server.address().port,
        method: "POST",
        headers: { "content-length": "4" },
      }, (response) => response.resume());
      request.end("ping");
    });
  });
});
