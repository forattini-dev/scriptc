import { readFileSync } from "node:fs";
import { createServer } from "node:tls";

const port = Number(process.argv[2]);
const cert = readFileSync(new URL("../../certs/localhost.pem", import.meta.url));
const key = readFileSync(new URL("../../certs/localhost-key.pem", import.meta.url));

const server = createServer({ cert, key }, (socket) => {
  socket.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    console.log(`driver saw ${text}`);
    socket.end(`echo:${text}`);
    if (text === "quit") {
      server.close(() => console.log("driver closed"));
    }
  });
});

server.on("tlsClientError", () => {});
server.listen(port, "127.0.0.1");
