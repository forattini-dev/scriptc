// Response.headers.has performs a case-insensitive presence check.
import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.setHeader("X-Agent", "scriptc-rust");
  response.end("accepted");
});

async function inspectHeaders(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/headers`);
  console.log(response.headers.has("x-AGENT"));
  console.log(response.headers.has("missing"));
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void inspectHeaders(server.address().port);
});
