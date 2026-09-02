// A native Fetch Response preserves the URL that produced it.
import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.end("accepted");
});

async function readUrl(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/resource?agent=rust`);
  console.log(response.url.endsWith("/resource?agent=rust"));
  console.log(await response.text());
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void readUrl(server.address().port);
});
