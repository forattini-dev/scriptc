import { createServer, get } from "node:http";

const server = createServer((_request, response) => {
  response.setTimeout(30, () => {
    console.log("response timeout");
    response.end("ok");
  });
});
server.setTimeout(30);
server.listen(0, "127.0.0.1", () => {
  get({ host: "127.0.0.1", port: server.address().port }, (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    response.on("end", () => {
      console.log("response body", response.statusCode, body);
      server.close();
    });
  });
});
