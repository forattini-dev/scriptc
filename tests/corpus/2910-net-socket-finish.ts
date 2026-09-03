import * as net from "node:net";

let finished = false;

const server = net.createServer((socket) => {
  socket.on("data", () => {});
  socket.on("end", () => socket.end());
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end("done");
  });
  client.on("finish", () => {
    finished = true;
  });
  client.on("close", () => server.close());
});

server.on("close", () => console.log("finish:", finished));
