// RequestInit record headers cross the static Fetch boundary and reach the
// native HTTP server on the wire.
import * as http from "node:http";

const server = http.createServer((request, response) => {
  console.log(request.headers["x-agent"]);
  response.end("accepted");
});

async function send(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/headers`, {
    headers: { "x-agent": "scriptc-rust" },
  });
  console.log(await response.text());
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void send(server.address().port);
});
