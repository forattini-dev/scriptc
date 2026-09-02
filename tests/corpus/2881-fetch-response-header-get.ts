// Response.headers.get performs a case-insensitive lookup on native Fetch
// response headers and returns null for a missing field.
import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.setHeader("X-Agent", "scriptc-rust");
  response.end("accepted");
});

async function readHeader(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/headers`);
  console.log(response.headers.get("x-AGENT"));
  console.log(response.headers.get("missing"));
  console.log(await response.text());
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void readHeader(server.address().port);
});
