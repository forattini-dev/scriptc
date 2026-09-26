import * as http from "node:http";

const server = http.createServer(() => {});
server.on("timeout", (socket) => console.log("listener", socket.destroyed));
console.log("same server", server.setTimeout(20, (socket) => {
  console.log("callback", socket.destroyed);
  socket.destroy();
  server.close();
}) === server);
server.listen(0, "127.0.0.1", () => {
  const client = http.request({ host: "127.0.0.1", port: server.address().port });
  client.on("error", () => console.log("client error"));
  client.end();
});
