import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer();
server.on("upgrade", (_request, socket) => {
  server.closeAllConnections();
  console.log("upgraded socket open", !socket.destroyed);
  socket.end("ALIVE");
  server.close();
});
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1");
  let body = "";
  client.on("connect", () => client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: scr\r\n\r\n"));
  client.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  client.on("end", () => console.log("received", body));
});
