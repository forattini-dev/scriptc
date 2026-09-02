// Response.json() stays native after fetch: UTF-8 body bytes become the
// checked-dynamic JSON tree that ordinary static code can validate and read.
import * as http from "node:http";

interface Payload {
  name: string;
  count: number;
  ready: boolean;
}

const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end('{"name":"rust","count":24,"ready":true}');
});

async function consume(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/data`);
  const payload = await response.json() as Payload;
  console.log(payload.name, payload.count, payload.ready);
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void consume(server.address().port);
});
