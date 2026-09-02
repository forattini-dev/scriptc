// Fetch Response metadata is exposed by the native body-reader handle.
import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.writeHead(201, "Made");
  response.end("accepted");
});

async function readStatus(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/status`);
  console.log(response.status, response.ok, response.statusText);
  console.log(await response.text());
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void readStatus(server.address().port);
});
