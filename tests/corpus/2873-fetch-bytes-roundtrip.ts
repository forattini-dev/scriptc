// Response.bytes() exposes the exact native body octets as a Uint8Array.
import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.end("Aé");
});

async function consume(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/bytes`);
  const bytes = await response.bytes();
  console.log(bytes.length, bytes[0], bytes[1], bytes[2]);
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void consume(server.address().port);
});
