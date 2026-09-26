import * as http from "node:http";

const server = http.createServer((_incoming, outgoing) => {
  outgoing.writeHead(200);
  outgoing.write("first");
});

server.listen(0, "127.0.0.1", () => {
  const client = http.request({ host: "127.0.0.1", port: server.address().port }, (response) => {
    response.on("data", (chunk: Buffer) => {
      console.log("body", chunk.toString());
      response.destroy();
    });
    response.on("error", () => console.log("error"));
    response.on("aborted", () => console.log("aborted", response.aborted));
    response.on("close", () => {
      console.log("closed", response.complete);
      server.close();
    });
  });
  client.on("error", () => console.log("client error"));
  client.end();
});
