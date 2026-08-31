import * as http from "node:http";

// Zero selects Node's default parser limit; it does not reject every request.
const server = http.createServer({ maxHeaderSize: 0 }, (_request, response) => {
  console.log("handler");
  response.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  http.get({ host: "127.0.0.1", port: server.address().port }, (response) => {
    console.log("status", response.statusCode);
    response.resume();
    response.on("end", () => server.close());
  });
});
