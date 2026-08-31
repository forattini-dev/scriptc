import * as http from "node:http";

// A server-specific maxHeaderSize rejects the oversized request before the
// request listener runs. Node's default clientError handling answers 431.
const server = http.createServer({ maxHeaderSize: 128 }, (_request, response) => {
  console.log("handler");
  response.end("unexpected");
});

server.listen(0, "127.0.0.1", () => {
  const request = http.get({
    host: "127.0.0.1",
    port: server.address().port,
    headers: { "x-probe": "x".repeat(256) },
  }, (response) => {
    console.log("status", response.statusCode);
    response.resume();
    response.on("end", () => server.close());
  });
  request.on("error", (error: NodeJS.ErrnoException) => {
    console.log("error", error.code);
    server.close();
  });
});
