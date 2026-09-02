// Static fetch owns the HTTP exchange without entering the JavaScript island.
// Pin the smallest useful Web API round-trip: the response promise settles,
// text() consumes the body, and the native event loop can serve both ends.
import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.end("native fetch ✓");
});

async function consume(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/text?q=1`);
  console.log(await response.text());
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void consume(server.address().port);
});
