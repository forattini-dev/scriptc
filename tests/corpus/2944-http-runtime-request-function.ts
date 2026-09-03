// A stable runtime condition can select the http/https request function.
// This exercises the plain arm while keeping the call itself indirect.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const secure = false;
const request = secure ? httpsRequest : httpRequest;

const server = createServer((_incoming, response) => {
  response.end("agent");
});

server.listen(0, "127.0.0.1", () => {
  const client = request({
    hostname: "127.0.0.1",
    port: server.address().port,
    path: "/runtime-choice",
  });
  client.once("response", (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    response.on("end", () => {
      console.log(response.statusCode, body);
      server.close();
    });
  });
  client.end();
});
