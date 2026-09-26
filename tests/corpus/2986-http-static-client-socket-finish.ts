import * as http from "node:http";

const server = http.createServer((incoming, outgoing) => {
  incoming.resume();
  incoming.on("end", () => outgoing.end("ok"));
});

server.listen(0, "127.0.0.1", () => {
  const outbound = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST" }, (response) => {
    response.resume();
    response.on("end", () => server.close());
  });
  console.log("initial", outbound.socket === outbound.connection, outbound.writableFinished, outbound.destroyed);
  outbound.on("socket", (socket) => {
    console.log("socket", socket === outbound.socket, socket.destroyed, outbound.writableFinished);
  });
  outbound.once("socket", () => console.log("socket once"));
  outbound.once("finish", () => {
    console.log("finish", outbound.writableEnded, outbound.writableFinished, outbound.destroyed);
  });
  outbound.on("close", () => {
    console.log("close", outbound.writableFinished, outbound.destroyed);
  });
  outbound.end("hi");
  console.log("ended", outbound.writableEnded, outbound.writableFinished);
});
