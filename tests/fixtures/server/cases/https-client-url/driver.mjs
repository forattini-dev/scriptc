import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const port = Number(process.argv[2]);
const cert = readFileSync(new URL("../../certs/localhost.pem", import.meta.url));
const key = readFileSync(new URL("../../certs/localhost-key.pem", import.meta.url));

const server = createServer({ cert, key }, (request, response) => {
  if (request.url === "/ready") {
    response.end("ok");
    return;
  }
  console.log(`driver saw ${request.method} ${request.url} conn=${request.headers.connection}`);
  if (request.url === "/one?q=1") {
    response.end("first secure URL");
    return;
  }
  if (request.url === "/two") {
    response.end("second secure URL");
    server.close(() => console.log("driver closed"));
    return;
  }
  response.writeHead(404);
  response.end("missing");
});

server.on("tlsClientError", () => {});
server.listen(port);
