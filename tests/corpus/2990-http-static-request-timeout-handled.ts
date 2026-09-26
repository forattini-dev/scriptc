import { createServer, request } from "node:http";

const server = createServer((incoming, outgoing) => {
  incoming.setTimeout(30, () => {
    console.log("request timeout", incoming.complete, incoming.aborted);
    outgoing.end("ok");
  });
});
server.setTimeout(30);
server.listen(0, "127.0.0.1", () => {
  const client = request({ host: "127.0.0.1", port: server.address().port, method: "POST", headers: { "Content-Length": "5" } }, (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    response.on("end", () => {
      console.log("request body", response.statusCode, body);
      client.destroy();
      server.close();
    });
  });
  client.on("error", () => {
    console.log("client error");
    server.close();
  });
  client.write("x");
});
