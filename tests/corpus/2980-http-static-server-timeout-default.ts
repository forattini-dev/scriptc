import * as http from "node:http";

const server = http.createServer(() => {});
server.setTimeout(20);
console.log("timeout", server.timeout);
server.listen(0, "127.0.0.1", () => {
  const client = http.request({ host: "127.0.0.1", port: server.address().port });
  client.on("error", () => {
    console.log("closed on timeout");
    server.close();
  });
  client.end();
});
