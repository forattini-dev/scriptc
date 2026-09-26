import * as http from "node:http";

const server = http.createServer();
server.on("connection", (socket) => console.log("connection", socket.destroyed));
server.on("request", (incoming, outgoing) => {
  console.log("request", incoming.method);
  outgoing.end("ok");
});
server.on("close", () => console.log("server close"));
server.listen(0, "127.0.0.1", () => {
  const client = http.request({ host: "127.0.0.1", port: server.address().port });
  client.on("response", (incoming) => {
    console.log("response", incoming.statusCode);
    incoming.on("data", (chunk: Buffer) => console.log("data", chunk.toString()));
    incoming.on("end", () => server.close());
  });
  client.on("close", () => console.log("client close"));
  client.end();
});
