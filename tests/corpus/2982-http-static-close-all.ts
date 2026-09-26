import * as http from "node:http";

const server = http.createServer(() => {
  console.log("request started");
  server.closeAllConnections();
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const client = http.request({ host: "127.0.0.1", port: server.address().port });
  client.on("error", () => console.log("client error"));
  client.on("close", () => console.log("client close"));
  client.end();
});
