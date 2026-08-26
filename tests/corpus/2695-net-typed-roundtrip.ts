// Typed node:net round-trip: the native backend owns both ends of a real
// loopback TCP connection, carries string and Buffer writes, and delivers
// connect/data/end/close callbacks before the server shuts down.
import * as net from "node:net";

let connected = false;
let serverEnded = false;
let clientEnded = false;
let clientClosed = false;
let serverRead = "";
let clientRead = "";

const server = net.createServer();
server.on("connection", (socket) => {
  socket.on("data", (chunk) => {
    serverRead = serverRead + chunk.toString();
    if (serverRead === "ping") {
      socket.write("po");
      socket.end(Buffer.from("ng"));
    }
  });
  socket.once("end", () => {
    serverEnded = true;
  });
});

server.on("listening", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    connected = true;
    client.write("pi");
    client.end(Buffer.from("ng"));
  });
  client.on("data", (chunk) => {
    clientRead = clientRead + chunk.toString();
  });
  client.once("end", () => {
    clientEnded = true;
  });
  client.once("close", () => {
    clientClosed = true;
    server.close();
  });
});

server.once("close", () => {
  console.log(connected, serverRead, serverEnded, clientRead, clientEnded, clientClosed);
});
server.listen(0);
