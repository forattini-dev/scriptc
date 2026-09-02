// Starting native Response body consumption flips bodyUsed synchronously,
// before the returned promise settles.
import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.end("accepted");
});

async function consume(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/body`);
  console.log(response.bodyUsed);
  const text = response.text();
  console.log(response.bodyUsed);
  console.log(await text);
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void consume(server.address().port);
});
