import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.writeHead(204);
  response.end();
});

async function request(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/notification`);
  console.log(response.status, response.body === null, (await response.text()).length);
  server.close();
}

server.listen(0, "127.0.0.1", () => { void request(server.address().port); });
